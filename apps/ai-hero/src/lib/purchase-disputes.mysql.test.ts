import { preserveQueryResultShape } from '@/db/mysql-query-client'
import * as schema from '@/db/schema'
import { eq, is, SQL } from 'drizzle-orm'
import { getTableConfig, MySqlDialect } from 'drizzle-orm/mysql-core'
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'

const state = vi.hoisted(() => ({ database: undefined as unknown }))
vi.mock('@/db', () => ({
	get db() {
		return state.database
	},
}))

import {
	applyLostDispute,
	isUserBlockedFromPurchasing,
	previewLostDispute,
	readDisputeRecord,
	restoreDisputedPurchaseAccess,
	revokeDisputedPurchaseAccess,
} from './purchase-disputes'

const uri = process.env.AIH_PURCHASE_DISPUTES_MYSQL_URL
const suite = uri ? describe : describe.skip
const dialect = new MySqlDialect()
const tables = [
	schema.users,
	schema.purchases,
	schema.entitlements,
	schema.entitlementTypes,
]

// Disposable DDL from the installed schema, never a production clone.
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
		await pool.query(`DROP TABLE IF EXISTS \`${config.name}\``)
		await pool.query(
			`CREATE TABLE \`${config.name}\` (${columns.join(',')}) ENGINE=InnoDB`,
		)
	}
}

const NOW = new Date('2026-10-09T12:00:00.000Z')
const LATER = new Date('2026-10-20T12:00:00.000Z')

suite('purchase disputes: real MySQL 8', () => {
	let pool: Pool
	let database: MySql2Database<typeof schema>

	beforeAll(async () => {
		const parsed = new URL(uri!)
		if (
			!['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
			parsed.pathname !== '/purchase_disputes_test'
		)
			throw new Error(
				'Only the loopback purchase_disputes_test fixture is allowed',
			)
		const server = new URL(uri!)
		server.pathname = '/'
		const bootstrap = await mysql.createConnection({ uri: server.toString() })
		await bootstrap.query(
			'CREATE DATABASE IF NOT EXISTS purchase_disputes_test',
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
		database = drizzle(pool, { schema, mode: 'planetscale' })
		state.database = database
	}, 30000)

	afterAll(async () => {
		await pool?.end()
	})

	beforeEach(async () => {
		for (const table of tables)
			await pool.query(`DELETE FROM \`${getTableConfig(table).name}\``)
		await database.insert(schema.users).values([
			{
				id: 'buyer',
				email: 'buyer@example.test',
				fields: { timezone: 'UTC' },
			},
			{ id: 'bystander', email: 'bystander@example.test' },
		])
		await database.insert(schema.entitlementTypes).values([
			{ id: 'workshop-type', name: 'workshop_content_access' },
			{ id: 'discord-type', name: 'workshop_discord_role' },
			{ id: 'credit-type', name: 'apply_special_credit' },
		])
		await database.insert(schema.purchases).values([
			{
				id: 'disputed',
				userId: 'buyer',
				productId: 'product-a',
				status: 'Restricted',
				totalAmount: '100',
				fields: { attribution: { source: 'fixture' } },
			},
			{
				id: 'other-product',
				userId: 'buyer',
				productId: 'product-b',
				status: 'Valid',
				totalAmount: '50',
			},
			{
				id: 'bystander-purchase',
				userId: 'bystander',
				productId: 'product-a',
				status: 'Valid',
				totalAmount: '100',
			},
		])
		const entitlement = (
			id: string,
			sourceId: string,
			overrides: Partial<typeof schema.entitlements.$inferInsert> = {},
		) => ({
			id,
			entitlementType: 'workshop-type',
			userId: 'buyer',
			sourceType: 'PURCHASE',
			sourceId,
			metadata: { contentIds: ['workshop-1'] },
			...overrides,
		})
		await database.insert(schema.entitlements).values([
			entitlement('content', 'disputed'),
			entitlement('discord', 'disputed', {
				entitlementType: 'discord-type',
				metadata: { discordRoleId: 'role-1' },
			}),
			// Removed earlier for an unrelated reason; a win must not revive it.
			entitlement('stale', 'disputed', {
				deletedAt: new Date('2026-01-01T00:00:00Z'),
			}),
			entitlement('credit', 'coupon-1', {
				entitlementType: 'credit-type',
				sourceType: 'COUPON',
				metadata: { eligibilityProductId: 'product-a' },
			}),
			entitlement('other-product-content', 'other-product'),
			entitlement('bystander-content', 'bystander-purchase', {
				userId: 'bystander',
			}),
		])
	})

	async function purchase(id: string) {
		return database.query.purchases.findFirst({
			where: eq(schema.purchases.id, id),
		})
	}
	async function active() {
		return (await database.query.entitlements.findMany())
			.filter((row) => !row.deletedAt)
			.map((row) => row.id)
			.sort()
	}

	it('created: cuts exactly the purchase rows and unused credits, records them, and is idempotent', async () => {
		const result = await revokeDisputedPurchaseAccess({
			purchaseId: 'disputed',
			stripeDisputeId: 'du_1',
			previousStatus: 'Restricted',
			now: NOW,
		})

		expect(result).toMatchObject({
			kind: 'revoked',
			userId: 'buyer',
			discordRoles: [
				{ entitlementId: 'discord', discordRoleId: 'role-1', kind: 'workshop' },
			],
		})
		const row = await purchase('disputed')
		expect(row!.status).toBe('Disputed')
		expect(row!.fields).toMatchObject({ attribution: { source: 'fixture' } })
		expect(readDisputeRecord(row!.fields)).toEqual({
			stripeDisputeId: 'du_1',
			previousStatus: 'Restricted',
			revokedAt: NOW.toISOString(),
			revokedEntitlementIds: ['content', 'discord', 'credit'],
		})
		expect(await active()).toEqual([
			'bystander-content',
			'other-product-content',
		])

		await expect(
			revokeDisputedPurchaseAccess({
				purchaseId: 'disputed',
				stripeDisputeId: 'du_1',
				now: LATER,
			}),
		).resolves.toMatchObject({ kind: 'already-revoked' })
		expect(
			readDisputeRecord((await purchase('disputed'))!.fields)!.revokedAt,
		).toBe(NOW.toISOString())
	})

	it('created: trusts the status commerce read when it already wrote Disputed', async () => {
		await database
			.update(schema.purchases)
			.set({ status: 'Disputed' })
			.where(eq(schema.purchases.id, 'disputed'))
		await revokeDisputedPurchaseAccess({
			purchaseId: 'disputed',
			stripeDisputeId: 'du_1',
			previousStatus: 'Restricted',
			now: NOW,
		})
		expect(
			readDisputeRecord((await purchase('disputed'))!.fields)!.previousStatus,
		).toBe('Restricted')
	})

	it('created: keeps unused credits while another paid purchase of the product survives', async () => {
		await database.insert(schema.purchases).values({
			id: 'second-copy',
			userId: 'buyer',
			productId: 'product-a',
			status: 'Valid',
			totalAmount: '100',
		})
		await revokeDisputedPurchaseAccess({
			purchaseId: 'disputed',
			stripeDisputeId: 'du_1',
			now: NOW,
		})
		expect(await active()).toContain('credit')
	})

	it('won: restores the recorded status and rows, not unrelated deletions, once', async () => {
		await revokeDisputedPurchaseAccess({
			purchaseId: 'disputed',
			stripeDisputeId: 'du_1',
			previousStatus: 'Restricted',
			now: NOW,
		})
		await expect(
			restoreDisputedPurchaseAccess({
				purchaseId: 'disputed',
				stripeDisputeId: 'du_other',
			}),
		).resolves.toMatchObject({ kind: 'skipped', reason: 'different-dispute' })

		const result = await restoreDisputedPurchaseAccess({
			purchaseId: 'disputed',
			stripeDisputeId: 'du_1',
			now: LATER,
		})
		expect(result).toMatchObject({
			kind: 'restored',
			discordRoles: [{ entitlementId: 'discord', discordRoleId: 'role-1' }],
		})
		const row = await purchase('disputed')
		expect(row!.status).toBe('Restricted')
		expect(readDisputeRecord(row!.fields)).toMatchObject({
			outcome: 'won',
			closedAt: LATER.toISOString(),
		})
		expect(await active()).toEqual([
			'bystander-content',
			'content',
			'credit',
			'discord',
			'other-product-content',
		])
		await expect(
			restoreDisputedPurchaseAccess({
				purchaseId: 'disputed',
				stripeDisputeId: 'du_1',
			}),
		).resolves.toMatchObject({ kind: 'skipped', reason: 'closed-won' })
		expect(await isUserBlockedFromPurchasing('buyer')).toBe(false)
	})

	it('won: leaves a purchase that was never cut alone', async () => {
		await expect(
			restoreDisputedPurchaseAccess({
				purchaseId: 'disputed',
				stripeDisputeId: 'du_1',
			}),
		).resolves.toMatchObject({ kind: 'skipped', reason: 'no-record' })
		expect((await purchase('disputed'))!.status).toBe('Restricted')
	})

	it('lost: cuts a never-marked purchase, blocks only the buyer, and keeps user fields', async () => {
		const result = await applyLostDispute({
			purchaseId: 'disputed',
			stripeDisputeId: 'du_1',
			previousStatus: 'Restricted',
			now: NOW,
		})

		expect(result).toMatchObject({
			kind: 'blocked',
			userId: 'buyer',
			alreadyBlocked: false,
			revocation: { kind: 'revoked' },
			block: {
				reason: 'chargeback_lost',
				purchaseId: 'disputed',
				stripeDisputeId: 'du_1',
				blockedAt: NOW.toISOString(),
			},
		})
		const row = await purchase('disputed')
		expect(row!.status).toBe('Disputed')
		expect(readDisputeRecord(row!.fields)).toMatchObject({
			previousStatus: 'Restricted',
			outcome: 'lost',
		})
		expect(await active()).toEqual([
			'bystander-content',
			'other-product-content',
		])
		const buyer = await database.query.users.findFirst({
			where: eq(schema.users.id, 'buyer'),
		})
		expect(buyer!.fields).toMatchObject({ timezone: 'UTC' })
		expect(await isUserBlockedFromPurchasing('buyer')).toBe(true)
		expect(await isUserBlockedFromPurchasing('bystander')).toBe(false)
		expect(await isUserBlockedFromPurchasing(undefined)).toBe(false)

		await expect(
			applyLostDispute({
				purchaseId: 'disputed',
				stripeDisputeId: 'du_1',
				now: LATER,
			}),
		).resolves.toMatchObject({
			kind: 'blocked',
			alreadyBlocked: true,
			revocation: { kind: 'already-revoked' },
			block: { blockedAt: NOW.toISOString() },
		})
		// A loss is final: a stray won event cannot restore it.
		await expect(
			restoreDisputedPurchaseAccess({
				purchaseId: 'disputed',
				stripeDisputeId: 'du_1',
			}),
		).resolves.toMatchObject({ kind: 'skipped', reason: 'closed-lost' })
	})

	it('backfill preview: plans exactly what a lost dispute applies and writes nothing', async () => {
		const input = {
			purchaseId: 'disputed',
			stripeDisputeId: 'du_1',
			previousStatus: 'Restricted',
		}
		const preview = await previewLostDispute(input)
		expect(preview).toEqual({
			kind: 'planned',
			purchaseId: 'disputed',
			userId: 'buyer',
			status: 'Restricted',
			plannedStatus: 'Disputed',
			restoreStatus: 'Restricted',
			alreadyRevoked: false,
			revokeEntitlementIds: ['content', 'discord'],
			revokeCreditEntitlementIds: ['credit'],
			discordRoleEntitlementIds: ['discord'],
			userAlreadyBlocked: false,
		})
		expect((await purchase('disputed'))!.status).toBe('Restricted')
		expect(await active()).toContain('content')

		const applied = await applyLostDispute({ ...input, now: NOW })
		expect(applied.kind === 'blocked' && applied.revocation).toMatchObject({
			record: {
				revokedEntitlementIds: [
					...(preview.kind === 'planned' ? preview.revokeEntitlementIds : []),
					...(preview.kind === 'planned'
						? preview.revokeCreditEntitlementIds
						: []),
				],
			},
		})
		await expect(previewLostDispute(input)).resolves.toMatchObject({
			alreadyRevoked: true,
			plannedStatus: 'Disputed',
			revokeEntitlementIds: [],
			userAlreadyBlocked: true,
		})
	})

	it('lost: blocks the buyer of an already refunded purchase without touching it', async () => {
		await database
			.update(schema.purchases)
			.set({ status: 'Refunded' })
			.where(eq(schema.purchases.id, 'disputed'))
		const result = await applyLostDispute({
			purchaseId: 'disputed',
			stripeDisputeId: 'du_1',
			now: NOW,
		})
		expect(result).toMatchObject({
			kind: 'blocked',
			revocation: { kind: 'skipped', reason: 'status-Refunded' },
		})
		expect((await purchase('disputed'))!.status).toBe('Refunded')
		expect(await isUserBlockedFromPurchasing('buyer')).toBe(true)
	})
})
