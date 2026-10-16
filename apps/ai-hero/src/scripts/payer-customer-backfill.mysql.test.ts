import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import * as schema from '@/db/schema'
import { eq, is, SQL } from 'drizzle-orm'
import { getTableConfig, MySqlDialect } from 'drizzle-orm/mysql-core'
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
	countPlan,
	planAll,
	runReadback,
	runWrite,
} from '../../scripts/payer-customer-backfill'
import {
	assembleCustomerFacts,
	createDrizzleDbPorts,
	createPorts,
	type StripeLike,
} from '../../scripts/payer-customer-backfill-runtime'

/**
 * Payer customer backfill against a real MySQL 8 fixture with a recording
 * Stripe fake. Synthetic rows only. Opt in with AIH_PAYER_BACKFILL_MYSQL_URL
 * (loopback, /payer_backfill_rig_test).
 */
const uri = process.env.AIH_PAYER_BACKFILL_MYSQL_URL
const suite = uri ? describe : describe.skip
const dialect = new MySqlDialect()
const tables = [
	schema.users,
	schema.purchases,
	schema.purchaseUserTransfer,
	schema.merchantCharge,
	schema.merchantCustomer,
	schema.merchantSubscription,
	schema.subscription,
]

async function createFixtureSchema(pool: Pool) {
	for (const table of tables) {
		const config = getTableConfig(table)
		const columns = config.columns.map((column) => {
			const fallback =
				column.default === undefined
					? ''
					: column.default === null
						? ' DEFAULT NULL'
						: is(column.default, SQL)
							? ` DEFAULT ${dialect.sqlToQuery(column.default).sql}`
							: column.getSQLType() === 'json'
								? ` DEFAULT ('${JSON.stringify(column.default)}')`
								: ` DEFAULT '${String(column.default)}'`
			return `\`${column.name}\` ${column.getSQLType()}${column.notNull ? ' NOT NULL' : ''}${fallback}${column.primary ? ' PRIMARY KEY' : ''}`
		})
		if (!config.columns.some((column) => column.primary))
			for (const key of config.primaryKeys)
				columns.push(
					`PRIMARY KEY (${key.columns.map((column) => `\`${column.name}\``).join(',')})`,
				)
		for (const unique of config.uniqueConstraints ?? [])
			columns.push(
				`UNIQUE KEY \`${unique.name}\` (${unique.columns.map((c) => `\`${c.name}\``).join(',')})`,
			)
		await pool.query(`DROP TABLE IF EXISTS \`${config.name}\``)
		await pool.query(
			`CREATE TABLE \`${config.name}\` (${columns.join(',')}) ENGINE=InnoDB`,
		)
	}
}

/** Recording Stripe fake: reads, and one write that dedupes by idempotency key. */
function recordingStripe() {
	const customers = new Map<
		string,
		{ email: string; name: string | null; created: number[] }
	>()
	const usage = new Map<string, { charges: number[] }>()
	const calls: string[] = []
	const keys = new Set<string>()
	let applied = 0
	const list = <T>(items: T[]) => ({
		autoPagingToArray: async () => items,
	})
	const stripe: StripeLike = {
		customers: {
			retrieve: async (id) => {
				calls.push(`retrieve:${id}`)
				const c = customers.get(id)
				return c ? { email: c.email, name: c.name } : { deleted: true }
			},
			listPaymentMethods: () => list([]),
			listSources: () => list([]),
			update: async (id, params, options) => {
				calls.push(`update:${id}`)
				if (keys.has(options.idempotencyKey)) return {}
				keys.add(options.idempotencyKey)
				const c = customers.get(id)!
				c.email = params.email
				// An empty name clears the field, as Stripe does.
				if (params.name !== undefined)
					c.name = params.name === '' ? null : params.name
				applied += 1
				return {}
			},
		},
		charges: {
			list: ({ customer }) =>
				list(
					(usage.get(customer)?.charges ?? []).map((created) => ({ created })),
				),
		},
		paymentIntents: { list: () => list([]) },
		invoices: { list: () => list([]) },
		subscriptions: { list: () => list([]) },
	}
	return {
		stripe,
		customers,
		usage,
		calls,
		applied: () => applied,
		writeCalls: () => calls.filter((c) => c.startsWith('update:')),
	}
}

const T0 = new Date('2026-03-01T00:00:00Z')
const DAY = 86400000

suite('payer customer backfill against real MySQL 8', () => {
	let pool: Pool
	let db: MySql2Database<typeof schema>

	beforeAll(async () => {
		const parsed = new URL(uri!)
		if (
			!['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
			parsed.pathname !== '/payer_backfill_rig_test'
		)
			throw new Error(
				'Only the loopback payer_backfill_rig_test fixture is allowed',
			)
		const server = new URL(uri!)
		server.pathname = '/'
		const bootstrap = await mysql.createConnection({ uri: server.toString() })
		await bootstrap.query(
			'CREATE DATABASE IF NOT EXISTS payer_backfill_rig_test',
		)
		await bootstrap.end()
		pool = preserveQueryResultShape(
			mysql.createPool({ uri: uri!, connectionLimit: 4, timezone: 'Z' }),
		)
		const getConnection = pool.getConnection.bind(pool)
		pool.getConnection = (async () =>
			preserveQueryResultShape(
				await getConnection(),
			)) as typeof pool.getConnection
		await createFixtureSchema(pool)
		db = drizzle(pool, { schema, mode: 'planetscale' })
	}, 60000)
	afterAll(async () => {
		await pool?.end()
	})

	const fake = { current: recordingStripe() }
	let journal = ''

	/** One customer; `holder` is who the customer row names. */
	async function seedCustomer(input: {
		n: string
		holder: string
		chargeUser: string
		purchaseUser: string
		hops: { id: string; from: string; to: string; at: Date }[]
		stripeEmail: string
	}) {
		await db.insert(schema.merchantCustomer).values({
			id: `mcu-${input.n}`,
			identifier: `cus_${input.n}`,
			merchantAccountId: 'ma',
			userId: input.holder,
			status: 1,
		})
		await db.insert(schema.merchantCharge).values({
			id: `mch-${input.n}`,
			identifier: `ch_${input.n}`,
			merchantAccountId: 'ma',
			merchantProductId: 'mp',
			merchantCustomerId: `mcu-${input.n}`,
			userId: input.chargeUser,
			status: 1,
		})
		await db.insert(schema.purchases).values({
			id: `pur-${input.n}`,
			userId: input.purchaseUser,
			productId: 'prod',
			status: 'Valid',
			totalAmount: '100',
			merchantChargeId: `mch-${input.n}`,
		})
		for (const hop of input.hops)
			await db.insert(schema.purchaseUserTransfer).values({
				id: hop.id,
				purchaseId: `pur-${input.n}`,
				sourceUserId: hop.from,
				targetUserId: hop.to,
				transferState: 'COMPLETED',
				completedAt: hop.at,
				expiresAt: new Date(hop.at.getTime() + DAY),
			})
		fake.current.customers.set(`cus_${input.n}`, {
			email: input.stripeEmail,
			name: 'Old Name',
			created: [],
		})
	}

	beforeEach(async () => {
		for (const table of tables) await db.delete(table)
		fake.current = recordingStripe()
		journal = join(await mkdtemp(join(tmpdir(), 'payer-rig-')), 'journal.jsonl')
		await db.insert(schema.users).values([
			{ id: 'user-a', email: 'a@example.test', name: 'Payer A' },
			{ id: 'user-b', email: 'b@example.test', name: 'Holder B' },
			{ id: 'user-c', email: 'c@example.test', name: 'Holder C' },
			{ id: 'user-d', email: 'd@example.test', name: null },
			{ id: 'user-e', email: 'e@example.test', name: 'Holder E' },
		])
		// 1. Pre-fix transfer A to B: customer and charge followed B.
		await seedCustomer({
			n: '1',
			holder: 'user-b',
			chargeUser: 'user-b',
			purchaseUser: 'user-b',
			hops: [{ id: 'put-1', from: 'user-a', to: 'user-b', at: T0 }],
			stripeEmail: 'b@example.test',
		})
		// 2. Post-fix transfer: only the purchase moved; the customer stays on A.
		await seedCustomer({
			n: '2',
			holder: 'user-a',
			chargeUser: 'user-a',
			purchaseUser: 'user-b',
			hops: [{ id: 'put-2', from: 'user-a', to: 'user-b', at: T0 }],
			stripeEmail: 'a@example.test',
		})
		// 3. Chain A to B to C, pre-fix: the payer is A.
		await seedCustomer({
			n: '3',
			holder: 'user-c',
			chargeUser: 'user-c',
			purchaseUser: 'user-c',
			hops: [
				{ id: 'put-3a', from: 'user-a', to: 'user-b', at: T0 },
				{
					id: 'put-3b',
					from: 'user-b',
					to: 'user-c',
					at: new Date(T0.getTime() + DAY),
				},
			],
			stripeEmail: 'c@example.test',
		})
		// 4. Pre-fix, but the holder charged the customer after the transfer.
		await seedCustomer({
			n: '4',
			holder: 'user-b',
			chargeUser: 'user-b',
			purchaseUser: 'user-b',
			hops: [{ id: 'put-4', from: 'user-a', to: 'user-b', at: T0 }],
			stripeEmail: 'b@example.test',
		})
		fake.current.usage.set('cus_4', { charges: [T0.getTime() / 1000 + 60] })
		// 5. Pre-fix, payer has no name: the holder's name must not stay behind.
		await seedCustomer({
			n: '5',
			holder: 'user-e',
			chargeUser: 'user-e',
			purchaseUser: 'user-e',
			hops: [{ id: 'put-5', from: 'user-d', to: 'user-e', at: T0 }],
			stripeEmail: 'e@example.test',
		})
		fake.current.customers.get('cus_5')!.name = 'Holder E'
	})

	const portsFor = () =>
		createPorts({
			db,
			stripe: fake.current.stripe,
			journalPath: journal,
			rate: 1000,
		})
	const userOf = async (n: string) =>
		(
			await db.query.merchantCustomer.findFirst({
				where: eq(schema.merchantCustomer.id, `mcu-${n}`),
			})
		)?.userId

	it('plans each shape, writes only the moves, and reads back clean', async () => {
		const ports = portsFor()
		const plan = planAll(await ports.loadFacts())
		const counts = countPlan(plan)
		expect(counts).toMatchObject({
			total: 5,
			move: 3,
			payerHasOtherCustomer: 2,
		})
		expect(counts.skip['already-on-payer']).toBe(1)
		expect(counts.carveOut['holder-charge-after-transfer']).toBe(1)
		const byCustomer = Object.fromEntries(plan.map((p) => [p.customerId, p]))
		expect(byCustomer['mcu-1']).toMatchObject({
			decision: 'move',
			payerUserId: 'user-a',
		})
		expect(byCustomer['mcu-3']).toMatchObject({
			decision: 'move',
			payerUserId: 'user-a',
		})
		expect(byCustomer['mcu-2']).toMatchObject({ reason: 'already-on-payer' })
		expect(byCustomer['mcu-4']).toMatchObject({ decision: 'carve-out' })

		const result = await runWrite(
			{ approval: 'rig', planHash: counts.planHash, batch: 25 },
			ports,
		)
		expect(result).toMatchObject({
			status: 'complete',
			moved: 3,
			conflicts: 0,
		})
		expect(await userOf('1')).toBe('user-a')
		expect(await userOf('3')).toBe('user-a')
		expect(await userOf('2')).toBe('user-a')
		expect(await userOf('4')).toBe('user-b')
		// Stripe saw email and name changes for the three moves only.
		expect(fake.current.writeCalls().sort()).toEqual([
			'update:cus_1',
			'update:cus_3',
			'update:cus_5',
		])
		expect(await userOf('5')).toBe('user-d')
		// Payer D has no name: the name is cleared, not left as the holder's.
		expect(fake.current.customers.get('cus_5')).toMatchObject({
			email: 'd@example.test',
			name: null,
		})
		expect(fake.current.customers.get('cus_1')).toMatchObject({
			email: 'a@example.test',
			name: 'Payer A',
		})
		expect(fake.current.customers.get('cus_4')!.email).toBe('b@example.test')
		expect(await runReadback({ planHash: counts.planHash }, ports)).toEqual({
			planned: 3,
			onPayer: 3,
			conflicts: 0,
			drift: 0,
			stripeMismatch: 0,
			notYetWritten: 0,
		})
	})

	it('a row that changed before the write is drift: no write, no Stripe call', async () => {
		const ports = portsFor()
		const { planHash } = countPlan(planAll(await ports.loadFacts()))
		await db
			.update(schema.merchantCustomer)
			.set({ userId: 'user-c' })
			.where(eq(schema.merchantCustomer.id, 'mcu-1'))
		// The plan hash now differs for a fresh run, so approve the old plan the
		// way a resumed journal does: facts as planned, rows changed since.
		const stale = await Promise.all(
			(await ports.loadFacts()).map(async (f) => ({
				...f,
				holderUserId: f.customerId === 'mcu-1' ? 'user-b' : f.holderUserId,
			})),
		)
		ports.loadFacts = async () => stale
		expect(countPlan(planAll(stale)).planHash).toBe(planHash)
		const result = await runWrite(
			{ approval: 'rig', planHash, batch: 25 },
			ports,
		)
		expect(result).toMatchObject({ moved: 2, drift: 1, conflicts: 0 })
		expect(await userOf('1')).toBe('user-c')
		expect(fake.current.writeCalls().sort()).toEqual([
			'update:cus_3',
			'update:cus_5',
		])
	})

	it('a change after the fresh read is a conflict: nothing overwritten', async () => {
		const ports = portsFor()
		const { planHash } = countPlan(planAll(await ports.loadFacts()))
		const real = ports.loadCustomerFacts
		// The row moves right after the per-row read, before the CAS.
		ports.loadCustomerFacts = async (id) => {
			const facts = await real(id)
			if (id === 'mcu-1')
				await db
					.update(schema.merchantCustomer)
					.set({ userId: 'user-c' })
					.where(eq(schema.merchantCustomer.id, 'mcu-1'))
			return facts
		}
		const result = await runWrite(
			{ approval: 'rig', planHash, batch: 25 },
			ports,
		)
		expect(result).toMatchObject({ moved: 2, conflicts: 1 })
		expect(await userOf('1')).toBe('user-c')
		expect(fake.current.writeCalls()).not.toContain('update:cus_1')
	})

	it('holder use that appears after batch one drifts the row', async () => {
		const ports = portsFor()
		const { planHash } = countPlan(planAll(await ports.loadFacts()))
		const first = await runWrite({ approval: 'rig', planHash, batch: 1 }, ports)
		expect(first.status).toBe('batch-complete')
		fake.current.usage.set('cus_3', { charges: [T0.getTime() / 1000 + 60] })
		fake.current.usage.set('cus_5', { charges: [T0.getTime() / 1000 + 60] })
		const rest = await runWrite({ approval: 'rig', planHash, batch: 25 }, ports)
		expect(rest.drift).toBe(2)
		expect(await userOf('1')).toBe('user-a')
		expect(await userOf('3')).toBe('user-c')
		expect(await userOf('5')).toBe('user-e')
	})

	it('refuses to write while an unexpired transfer is open, not an expired one', async () => {
		const ports = portsFor()
		const { planHash } = countPlan(planAll(await ports.loadFacts()))
		await db.insert(schema.purchaseUserTransfer).values({
			id: 'put-old',
			purchaseId: 'pur-1',
			sourceUserId: 'user-b',
			targetUserId: 'user-c',
			transferState: 'VERIFIED',
			expiresAt: new Date(Date.now() - DAY),
		})
		expect(await createDrizzleDbPorts(db).countInFlightTransfers()).toBe(0)
		await db.insert(schema.purchaseUserTransfer).values({
			id: 'put-open',
			purchaseId: 'pur-1',
			sourceUserId: 'user-b',
			targetUserId: 'user-c',
			transferState: 'VERIFIED',
			expiresAt: new Date(Date.now() + DAY),
		})
		expect(await createDrizzleDbPorts(db).countInFlightTransfers()).toBe(1)
		await expect(
			runWrite({ approval: 'rig', planHash, batch: 25 }, ports),
		).rejects.toThrow(/^TransferInFlight:/)
		expect(fake.current.writeCalls()).toEqual([])
		expect(await userOf('1')).toBe('user-b')
	})

	it('the compare-and-set reports one row, then zero on replay', async () => {
		const dbPorts = createDrizzleDbPorts(db)
		const input = {
			customerId: 'mcu-1',
			holderUserId: 'user-b',
			payerUserId: 'user-a',
		}
		expect(await dbPorts.compareAndSet(input)).toBe(1)
		expect(await dbPorts.compareAndSet(input)).toBe(0)
	})

	it('assembles facts the same way the dry run does', async () => {
		const dbPorts = createDrizzleDbPorts(db)
		const facts = await assembleCustomerFacts(
			dbPorts,
			fake.current.stripe,
			async () => {},
		)()
		expect(facts).toHaveLength(5)
	})
})
