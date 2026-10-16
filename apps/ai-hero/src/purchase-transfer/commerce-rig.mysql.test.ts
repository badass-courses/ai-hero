import { preserveQueryResultShape } from '@/db/mysql-query-client'
import * as schema from '@/db/schema'
import { and, eq, is, SQL } from 'drizzle-orm'
import { getTableConfig, MySqlDialect } from 'drizzle-orm/mysql-core'
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Commerce rig, database half: the real accept and support-complete code
 * runs against a real MySQL 8 fixture, then the real readers are read back.
 * Stripe is a recording fake: every customer or charge call is logged, and
 * the proof is that none writes to the payer's customer.
 * Opt in with AIH_COMMERCE_RIG_MYSQL_URL (loopback, /commerce_rig_test).
 */
const state = vi.hoisted(() => ({
	database: undefined as unknown,
	session: null as { user: { id: string; email: string } } | null,
	stripeCalls: [] as string[],
}))

vi.mock('@/db', () => {
	const dbProxy = new Proxy(
		{},
		{
			get: (_t, key) =>
				(state.database as Record<string | symbol, unknown>)[key],
		},
	)
	const q = () => state.database as MySql2Database<typeof schema>
	return {
		db: dbProxy,
		courseBuilderAdapter: {
			getPurchaseUserTransferById: async ({ id }: { id: string }) =>
				(await q().query.purchaseUserTransfer.findFirst({
					where: eq(schema.purchaseUserTransfer.id, id),
				})) ?? null,
			getUserById: async (id: string) =>
				(await q().query.users.findFirst({ where: eq(schema.users.id, id) })) ??
				null,
			getPurchase: async (id: string) =>
				(await q().query.purchases.findFirst({
					where: eq(schema.purchases.id, id),
				})) ?? null,
			getEntitlementsForUser: async () => [],
		},
	}
})
vi.mock('@/env.mjs', () => ({
	env: {
		STRIPE_SECRET_TOKEN: 'sk_test_rig_fake',
		COURSEBUILDER_URL: 'https://coursebuilder.example.test',
		NEXT_PUBLIC_URL: 'https://aihero.example.test',
	},
}))
vi.mock('@/server/auth', () => ({
	authOptions: {},
	getServerAuthSession: async () => ({ session: state.session }),
}))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/coursebuilder/email-provider', () => ({ emailProvider: {} }))
vi.mock('@/coursebuilder/stripe-provider', () => ({
	stripeProvider: {
		getCustomer: async () => {
			state.stripeCalls.push('getCustomer')
			return {}
		},
		updateCustomer: async () => {
			state.stripeCalls.push('updateCustomer')
			return {}
		},
	},
}))
vi.mock('@coursebuilder/email/send-server-email', () => ({
	sendServerEmail: vi.fn(),
}))
vi.mock('@coursebuilder/email-templates/emails/purchase-transfer', () => ({
	default: vi.fn(),
}))
vi.mock('@/lib/find-or-create-user', () => ({
	findOrCreateUserWithPersonalOrg: vi.fn(),
}))
vi.mock('@react-email/render', () => ({ render: vi.fn(async () => '') }))
vi.mock('stripe', () => ({
	default: class Stripe {
		charges = {
			retrieve: async () => ({
				refunded: false,
				amount_refunded: 0,
				refunds: { data: [] },
			}),
		}
	},
}))
vi.mock('inngest', async (importOriginal) => ({
	...(await importOriginal<typeof import('inngest')>()),
	Inngest: class {
		send = vi.fn(async () => ({}))
	},
}))

import { getInvoicePurchasesForUser } from '@/lib/invoice-access'
import { resolveDisputeBuyer } from '@/lib/purchase-disputes'
import { drizzleInvoiceSettingsDataSource } from '@/lib/invoice-settings'
import { canViewPurchaseInvoice } from '@/lib/team-purchases'
import { canViewInvoice } from '@/lib/invoice-access-rules'
import { getOriginTransferForPurchase } from '@/lib/invoice-access'

import { acceptPurchaseTransfer } from './purchase-transfer-actions'
import { completeSupportPurchaseTransfer } from './support-complete'

const uri = process.env.AIH_COMMERCE_RIG_MYSQL_URL
const suite = uri ? describe : describe.skip
const dialect = new MySqlDialect()
const tables = [
	schema.users,
	schema.purchases,
	schema.purchaseUserTransfer,
	schema.purchaseTransferOutbox,
	schema.merchantCharge,
	schema.merchantCustomer,
	schema.products,
	schema.coupon,
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
								: column.getSQLType() === 'boolean'
									? ` DEFAULT ${column.default ? 1 : 0}`
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
		for (const index of config.indexes ?? [])
			if (index.config.unique)
				columns.push(
					`UNIQUE KEY \`${index.config.name}\` (${index.config.columns.map((c) => `\`${(c as { name: string }).name}\``).join(',')})`,
				)
		await pool.query(`DROP TABLE IF EXISTS \`${config.name}\``)
		await pool.query(
			`CREATE TABLE \`${config.name}\` (${columns.join(',')}) ENGINE=InnoDB`,
		)
	}
}

suite('commerce rig: transfers against real MySQL 8', () => {
	let pool: Pool
	let db: MySql2Database<typeof schema>
	const readback: Record<string, string>[] = []
	const row = (step: string, check: string, value: unknown) =>
		readback.push({ step, check, value: String(value) })

	beforeAll(async () => {
		const parsed = new URL(uri!)
		if (
			!['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
			parsed.pathname !== '/commerce_rig_test'
		)
			throw new Error('Only the loopback commerce_rig_test fixture is allowed')
		const server = new URL(uri!)
		server.pathname = '/'
		const bootstrap = await mysql.createConnection({ uri: server.toString() })
		await bootstrap.query('CREATE DATABASE IF NOT EXISTS commerce_rig_test')
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
		state.database = db
		process.env.INNGEST_EVENT_KEY = 'rig'

		await db.insert(schema.users).values([
			{ id: 'user-a', email: 'a@example.test', name: 'Payer A' },
			{ id: 'user-b', email: 'b@example.test', name: 'Holder B' },
			{ id: 'user-c', email: 'c@example.test', name: 'Holder C' },
		])
		await db.insert(schema.products).values({
			id: 'prod-rig',
			name: 'Rig Product',
			key: 'rig-product',
			fields: { slug: 'rig-product' },
			type: 'self-paced',
			status: 1,
		} as never)
		await db.insert(schema.products).values({
			id: 'prod-rig-2',
			name: 'Rig Product Two',
			key: 'rig-product-two',
			fields: { slug: 'rig-product-two' },
			type: 'self-paced',
			status: 1,
		} as never)
		await db.insert(schema.merchantCustomer).values({
			id: 'mcu-a',
			identifier: 'cus_rig_a',
			merchantAccountId: 'ma-rig',
			userId: 'user-a',
			status: 1,
		})
		for (const n of ['1', '2'])
			await db.insert(schema.merchantCharge).values({
				id: `mch-${n}`,
				identifier: `ch_rig_${n}`,
				merchantAccountId: 'ma-rig',
				merchantProductId: 'mp-rig',
				merchantCustomerId: 'mcu-a',
				userId: 'user-a',
				status: 1,
			})
		await db.insert(schema.purchases).values([
			{
				id: 'pur-1',
				userId: 'user-a',
				productId: 'prod-rig',
				status: 'Valid',
				totalAmount: '100',
				merchantChargeId: 'mch-1',
			},
			{
				id: 'pur-2',
				userId: 'user-a',
				productId: 'prod-rig',
				status: 'Valid',
				totalAmount: '100',
				merchantChargeId: 'mch-2',
			},
		])
		const future = new Date(Date.now() + 86400000)
		await db.insert(schema.purchaseUserTransfer).values([
			{
				id: 'put-1',
				purchaseId: 'pur-1',
				sourceUserId: 'user-a',
				targetUserId: 'user-b',
				transferState: 'INITIATED',
				expiresAt: future,
			},
			{
				id: 'put-2',
				purchaseId: 'pur-2',
				sourceUserId: 'user-a',
				targetUserId: 'user-c',
				transferState: 'INITIATED',
				expiresAt: future,
			},
		])
	}, 60000)

	afterAll(async () => {
		console.log(
			'\nRIG READBACK\n' +
				readback
					.map((r) => `| ${r.step} | ${r.check} | ${r.value} |`)
					.join('\n'),
		)
		await pool?.end()
	})

	const chargeUser = async (id: string) =>
		(await db.query.merchantCharge.findFirst({
			where: eq(schema.merchantCharge.id, id),
		}))!.userId
	// Same query as the adapter's getMerchantCustomerForUserId.
	const customerFor = async (userId: string) =>
		(
			await db.query.merchantCustomer.findFirst({
				where: eq(schema.merchantCustomer.userId, userId),
			})
		)?.identifier ?? null
	// Refund routing keys on the Stripe charge id, then charge -> purchase,
	// and entitlements are revoked for the purchase's holder (the adapter's
	// getPurchaseForStripeCharge, then refund-entitlements on purchase.userId).
	// Same two queries, no refund issued.
	const refundTarget = async (stripeChargeId: string) => {
		const charge = await db.query.merchantCharge.findFirst({
			where: eq(schema.merchantCharge.identifier, stripeChargeId),
		})
		const purchase = charge
			? await db.query.purchases.findFirst({
					where: eq(schema.purchases.merchantChargeId, charge.id),
				})
			: null
		return purchase?.id ?? null
	}
	const refundRevokesUser = async (stripeChargeId: string) => {
		const charge = await db.query.merchantCharge.findFirst({
			where: eq(schema.merchantCharge.identifier, stripeChargeId),
		})
		const purchase = charge
			? await db.query.purchases.findFirst({
					where: eq(schema.purchases.merchantChargeId, charge.id),
				})
			: null
		return purchase?.userId ?? null
	}

	it('self-service A -> B: purchase moves, payer keeps charge and customer', async () => {
		state.session = { user: { id: 'user-b', email: 'b@example.test' } }
		await acceptPurchaseTransfer({ purchaseUserTransferId: 'put-1' })
		// The workflow's compare-and-swap, after its invariants pass.
		await db
			.update(schema.purchaseUserTransfer)
			.set({ transferState: 'COMPLETED', completedAt: new Date() })
			.where(
				and(
					eq(schema.purchaseUserTransfer.id, 'put-1'),
					eq(schema.purchaseUserTransfer.transferState, 'VERIFIED'),
				),
			)

		const purchase = (await db.query.purchases.findFirst({
			where: eq(schema.purchases.id, 'pur-1'),
		}))!
		row('A->B', 'purchase holder', purchase.userId)
		row('A->B', 'charge user', await chargeUser('mch-1'))
		row('A->B', 'customer for A', await customerFor('user-a'))
		row('A->B', 'customer for B', await customerFor('user-b'))
		row('A->B', 'stripe customer writes', state.stripeCalls.length)
		expect(purchase.userId).toBe('user-b')
		expect(await chargeUser('mch-1')).toBe('user-a')
		expect(await customerFor('user-a')).toBe('cus_rig_a')
		// B has no customer, so B's next checkout creates their own.
		expect(await customerFor('user-b')).toBeNull()
		expect(state.stripeCalls).toEqual([])

		const listA = await getInvoicePurchasesForUser('user-a')
		const listB = await getInvoicePurchasesForUser('user-b')
		const a1 = listA.find((p) => p.id === 'pur-1')
		const b1 = listB.find((p) => p.id === 'pur-1')
		row('A->B', 'A sees / edits', `${Boolean(a1)} / ${a1?.canEdit}`)
		row('A->B', 'B sees / edits', `${Boolean(b1)} / ${b1?.canEdit}`)
		expect([Boolean(a1), a1?.canEdit]).toEqual([true, true])
		expect([Boolean(b1), b1?.canEdit]).toEqual([true, false])

		// The page and settings gate.
		const loaded =
			(await drizzleInvoiceSettingsDataSource.loadPurchaseByMerchantChargeId(
				'mch-1',
			))!
		const gate = (viewer: string) => canViewPurchaseInvoice(viewer, loaded, [])
		row('A->B', 'settings gate A / B', `${gate('user-a')} / ${gate('user-b')}`)
		expect([gate('user-a'), gate('user-b')]).toEqual([true, false])
		const origin = await getOriginTransferForPurchase('pur-1')
		expect(
			canViewInvoice({
				viewerId: 'user-b',
				purchaseUserId: 'user-b',
				payerUserId: 'user-a',
				transfer: origin,
			}),
		).toBe(true)

		const buyer = await resolveDisputeBuyer(db as never, {
			id: 'pur-1',
			userId: 'user-b',
			merchantChargeId: 'mch-1',
		})
		row('A->B', 'dispute buyer', JSON.stringify(buyer))
		expect(buyer).toEqual({
			kind: 'resolved',
			userId: 'user-a',
			transferred: true,
		})

		row(
			'A->B',
			'refund dry run resolves purchase',
			await refundTarget('ch_rig_1'),
		)
		expect(await refundTarget('ch_rig_1')).toBe('pur-1')
	})

	it('support move A -> C: one COMPLETED row, payer stays A', async () => {
		const result = await completeSupportPurchaseTransfer({
			transferId: 'put-2',
			purchaseId: 'pur-2',
			sourceUserId: 'user-a',
			targetEmail: 'c@example.test',
		})
		expect(result.state).toBe('completion_requested')
		await db
			.update(schema.purchaseUserTransfer)
			.set({ transferState: 'COMPLETED', completedAt: new Date() })
			.where(
				and(
					eq(schema.purchaseUserTransfer.id, 'put-2'),
					eq(schema.purchaseUserTransfer.transferState, 'VERIFIED'),
				),
			)
		const rows = await db.query.purchaseUserTransfer.findMany({
			where: eq(schema.purchaseUserTransfer.purchaseId, 'pur-2'),
		})
		row(
			'A->C support',
			'transfer rows / states',
			`${rows.length} / ${rows.map((r) => r.transferState)}`,
		)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.transferState).toBe('COMPLETED')
		expect(await chargeUser('mch-2')).toBe('user-a')
		const buyer = await resolveDisputeBuyer(db as never, {
			id: 'pur-2',
			userId: 'user-c',
			merchantChargeId: 'mch-2',
		})
		row('A->C support', 'dispute buyer', JSON.stringify(buyer))
		expect(buyer).toEqual({
			kind: 'resolved',
			userId: 'user-a',
			transferred: true,
		})
		const listA = (await getInvoicePurchasesForUser('user-a')).find(
			(p) => p.id === 'pur-2',
		)
		const listC = (await getInvoicePurchasesForUser('user-c')).find(
			(p) => p.id === 'pur-2',
		)
		row(
			'A->C support',
			'A edits / C edits',
			`${listA?.canEdit} / ${listC?.canEdit}`,
		)
		expect([listA?.canEdit, listC?.canEdit]).toEqual([true, false])
		row('A->C support', 'customer for C', await customerFor('user-c'))
		expect(await customerFor('user-a')).toBe('cus_rig_a')
	})

	it('self-service A -> B, then support B -> C: payer stays A throughout', async () => {
		await db.insert(schema.merchantCharge).values({
			id: 'mch-3',
			identifier: 'ch_rig_3',
			merchantAccountId: 'ma-rig',
			merchantProductId: 'mp-rig',
			merchantCustomerId: 'mcu-a',
			userId: 'user-a',
			status: 1,
		})
		await db.insert(schema.purchases).values({
			id: 'pur-3',
			userId: 'user-a',
			productId: 'prod-rig-2',
			status: 'Valid',
			totalAmount: '100',
			merchantChargeId: 'mch-3',
		})
		const expiresAt = new Date(Date.now() + 86400000)
		await db.insert(schema.purchaseUserTransfer).values({
			id: 'put-3',
			purchaseId: 'pur-3',
			sourceUserId: 'user-a',
			targetUserId: 'user-b',
			transferState: 'INITIATED',
			expiresAt,
		})
		const complete = (id: string) =>
			db
				.update(schema.purchaseUserTransfer)
				.set({ transferState: 'COMPLETED', completedAt: new Date() })
				.where(
					and(
						eq(schema.purchaseUserTransfer.id, id),
						eq(schema.purchaseUserTransfer.transferState, 'VERIFIED'),
					),
				)
		state.session = { user: { id: 'user-b', email: 'b@example.test' } }
		await acceptPurchaseTransfer({ purchaseUserTransferId: 'put-3' })
		await complete('put-3')
		await db.insert(schema.purchaseUserTransfer).values({
			id: 'put-4',
			purchaseId: 'pur-3',
			sourceUserId: 'user-b',
			targetUserId: 'user-c',
			transferState: 'INITIATED',
			expiresAt,
		})
		const moved = await completeSupportPurchaseTransfer({
			transferId: 'put-4',
			purchaseId: 'pur-3',
			sourceUserId: 'user-b',
			targetEmail: 'c@example.test',
		})
		await complete('put-4')
		const rows = await db.query.purchaseUserTransfer.findMany({
			where: eq(schema.purchaseUserTransfer.purchaseId, 'pur-3'),
		})
		const edits = async (user: string) =>
			(await getInvoicePurchasesForUser(user)).find((p) => p.id === 'pur-3')
				?.canEdit
		const purchase = (await db.query.purchases.findFirst({
			where: eq(schema.purchases.id, 'pur-3'),
		}))!
		row('A->B->C', 'support move result', moved.state)
		row(
			'A->B->C',
			'transfer rows / states',
			`${rows.length} / ${rows.map((r) => r.transferState)}`,
		)
		row(
			'A->B->C',
			'purchase holder / charge user',
			`${purchase.userId} / ${await chargeUser('mch-3')}`,
		)
		row(
			'A->B->C',
			'A / B / C edits',
			`${await edits('user-a')} / ${await edits('user-b')} / ${await edits('user-c')}`,
		)
		row('A->B->C', 'refund revokes', await refundRevokesUser('ch_rig_3'))
		expect(moved.state).toBe('completion_requested')
		expect(rows.map((r) => r.transferState)).toEqual(['COMPLETED', 'COMPLETED'])
		expect(purchase.userId).toBe('user-c')
		expect(await chargeUser('mch-3')).toBe('user-a')
		expect([
			await edits('user-a'),
			await edits('user-b'),
			await edits('user-c'),
		]).toEqual([true, undefined, false])
		expect(await refundRevokesUser('ch_rig_3')).toBe('user-c')
	})

	// The same user-visible outcome in every shape: pre-fix (charge rewritten
	// to the holder), post-fix (charge stays) and no transfer.
	it.each([
		['pre-fix transfer', 'user-b', 'user-b', true],
		['post-fix transfer', 'user-b', 'user-a', true],
		['no transfer', 'user-a', 'user-a', false],
	])(
		'shape %s: payer A edits, dispute buyer is A',
		async (shape, holder, chargeOwner, transferred) => {
			const n = shape.replace(/\W/g, '')
			await db.insert(schema.merchantCharge).values({
				id: `mch-${n}`,
				identifier: `ch_${n}`,
				merchantAccountId: 'ma-rig',
				merchantProductId: 'mp-rig',
				merchantCustomerId: 'mcu-a',
				userId: chargeOwner,
				status: 1,
			})
			await db.insert(schema.purchases).values({
				id: `pur-${n}`,
				userId: holder,
				productId: 'prod-rig',
				status: 'Valid',
				totalAmount: '100',
				merchantChargeId: `mch-${n}`,
			})
			if (transferred)
				await db.insert(schema.purchaseUserTransfer).values({
					id: `put-${n}`,
					purchaseId: `pur-${n}`,
					sourceUserId: 'user-a',
					targetUserId: holder,
					transferState: 'COMPLETED',
					completedAt: new Date('2026-09-01T00:00:00Z'),
				})
			// Pre-fix the holder also owns the payer's Stripe customer row.
			await db.insert(schema.merchantCustomer).values({
				id: `mcu-${n}`,
				identifier: `cus_${n}`,
				merchantAccountId: 'ma-rig',
				userId: chargeOwner,
				status: 1,
			})
			const holderReusesPayerCustomer =
				holder !== 'user-a' &&
				(
					await db.query.merchantCustomer.findFirst({
						where: eq(schema.merchantCustomer.id, `mcu-${n}`),
					})
				)?.userId === holder
			const buyer = await resolveDisputeBuyer(db as never, {
				id: `pur-${n}`,
				userId: holder,
				merchantChargeId: `mch-${n}`,
			})
			const edits = async (user: string) =>
				(await getInvoicePurchasesForUser(user)).find(
					(p) => p.id === `pur-${n}`,
				)?.canEdit
			row(
				shape,
				'dispute buyer / A edits / holder edits',
				`${buyer.kind === 'resolved' ? buyer.userId : buyer.reason} / ${await edits('user-a')} / ${holder === 'user-a' ? 'same as A' : await edits(holder)}`,
			)
			row(
				shape,
				'refund revokes / holder checkout reuses payer customer',
				`${await refundRevokesUser(`ch_${n}`)} / ${holderReusesPayerCustomer}${shape === 'pre-fix transfer' ? ' (known legacy, unchanged)' : ''}`,
			)
			expect(await refundRevokesUser(`ch_${n}`)).toBe(holder)
			expect(holderReusesPayerCustomer).toBe(shape === 'pre-fix transfer')
			expect(buyer).toMatchObject({ kind: 'resolved', userId: 'user-a' })
			expect(await edits('user-a')).toBe(true)
			if (holder !== 'user-a') expect(await edits(holder)).toBe(false)
		},
	)
})
