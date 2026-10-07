import { readFile } from 'node:fs/promises'
import { is, SQL, getTableName, eq } from 'drizzle-orm'
import {
	MySqlDialect,
	MySqlTable,
	getTableConfig,
} from 'drizzle-orm/mysql-core'
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import {
	beforeAll,
	beforeEach,
	afterAll,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import * as schema from '@/db/schema'
import { mysqlTable } from '@/db/mysql-table'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'

const state = vi.hoisted(() => ({
	database: undefined as unknown,
	adapter: undefined as unknown,
	beforeQuery: undefined as
		| ((sql: string, values: unknown[]) => Promise<void>)
		| undefined,
	afterQuery: undefined as
		| ((sql: string, values: unknown[]) => Promise<void>)
		| undefined,
	log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), flush: vi.fn() },
}))
vi.mock('@/db', () => ({
	get db() {
		return state.database
	},
	get courseBuilderAdapter() {
		return state.adapter
	},
}))
vi.mock('@/server/logger', () => ({ log: state.log }))
vi.mock('@/config', () => ({ default: {} }))
vi.mock('@/env.mjs', () => ({
	env: { NEXT_PUBLIC_URL: 'https://example.test' },
}))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		createFunction: (
			_config: unknown,
			_trigger: unknown,
			handler: unknown,
		) => ({ handler }),
	},
}))
vi.mock('@/emails/live-office-hours-invitation', () => ({
	default: vi.fn(),
	generateICSAttachments: vi.fn(),
}))
vi.mock('@/emails/welcome-archive-email', () => ({ default: vi.fn() }))
vi.mock('@/emails/welcome-cohort-email-team', () => ({ default: vi.fn() }))
vi.mock('@/emails/welcome-workshop-email-team', () => ({ default: vi.fn() }))
vi.mock('@coursebuilder/utils/resource-paths', () => ({
	getResourcePath: () => '/cohorts/c5',
}))
vi.mock('@coursebuilder/utils/send-an-email', () => ({ sendAnEmail: vi.fn() }))
vi.mock('@/inngest/config/product-types', () => ({
	ENTITLEMENT_CONFIG: { cohort: { resourceType: 'cohort' } },
	PRODUCT_TYPE_CONFIG: {
		cohort: {
			logPrefix: 'cohort',
			contentAccess: 'cohort_content_access',
			discordRole: 'cohort_discord_role',
			createEntitlement: async (
				...args: Parameters<
					typeof import('./entitlements').createCohortEntitlement
				>
			) => (await import('./entitlements')).createCohortEntitlement(...args),
		},
	},
	gatherResourceContexts: async () => [
		{
			resourceId: 'cohort-xdy1m',
			resourceType: 'cohort',
			productType: 'cohort',
		},
	],
	getResourceData: async () => ({
		id: 'cohort-xdy1m',
		type: 'cohort',
		createdById: 'owner',
		organizationId: 'fixture-content-org',
		createdByOrganizationMembershipId: 'fixture-content-member',
		createdAt: new Date('2026-10-07T00:00:00Z'),
		updatedAt: new Date('2026-10-07T00:00:00Z'),
		deletedAt: null,
		fields: { title: 'C5', slug: 'c5-fixture' },
		resources: [
			{
				resourceId: 'c5-workshop',
				resourceOfId: 'cohort-xdy1m',
				createdAt: new Date('2026-10-07T00:00:00Z'),
				updatedAt: new Date('2026-10-07T00:00:00Z'),
				deletedAt: null,
				resource: {
					id: 'c5-workshop',
					type: 'workshop',
					fields: { title: 'C5 draft workshop' },
				},
			},
		],
	}),
	getDiscordRoleId: () => null,
}))

import { grantIncludedProductEntitlements } from './included-product-entitlements'
import { softDeleteEntitlementsForPurchase } from './entitlements'
import { refundBulkPurchaseEntitlements } from './bulk-purchase-refund'
import { postPurchaseWorkflow } from '@/inngest/functions/post-purchase-workflow'

const uri = process.env.AIH_INCLUDED_PRODUCTS_MYSQL_URL
const suite = uri ? describe : describe.skip
const dialect = new MySqlDialect()
const quote = (name: string) => '`' + name.replaceAll('`', '``') + '`'
const literal = (value: unknown) =>
	typeof value === 'boolean'
		? String(Number(value))
		: typeof value === 'number'
			? String(value)
			: "'" +
				(typeof value === 'object' ? JSON.stringify(value) : String(value))
					.replaceAll('\\', '\\\\')
					.replaceAll("'", "''") +
				"'"
const tables = [
	...new Map(
		Object.values(schema)
			.filter((value) => is(value, MySqlTable))
			.map((table) => [getTableName(table), table]),
	).values(),
]

// Disposable test DDL comes from the installed schema, not a production clone.
async function createFixtureSchema(pool: Pool) {
	for (const table of tables) {
		const config = getTableConfig(table)
		const columns = config.columns.map((column) => {
			const defaultValue =
				column.default === undefined
					? ''
					: column.default === null
						? 'NULL'
						: is(column.default, SQL)
							? dialect.sqlToQuery(column.default).sql
							: literal(column.default)
			return `${quote(column.name)} ${column.getSQLType()}${column.notNull ? ' NOT NULL' : ''}${defaultValue ? ' DEFAULT ' + (column.getSQLType() === 'json' ? '(' + defaultValue + ')' : defaultValue) : ''}${column.primary ? ' PRIMARY KEY' : ''}${column.isUnique ? ' UNIQUE' : ''}`
		})
		if (!config.columns.some((column) => column.primary))
			for (const key of config.primaryKeys)
				columns.push(
					`PRIMARY KEY (${key.columns.map((column) => quote(column.name)).join(',')})`,
				)
		await pool.query(
			`CREATE TABLE IF NOT EXISTS ${quote(config.name)} (${columns.join(',')}) ENGINE=InnoDB`,
		)
		const [existing] = await pool.query<mysql.RowDataPacket[]>(
			`SHOW INDEX FROM ${quote(config.name)}`,
		)
		for (const index of config.indexes) {
			if (existing.some((row) => row.Key_name === index.config.name)) continue
			const names = index.config.columns.flatMap((column) =>
				'name' in column ? [quote(column.name)] : [],
			)
			if (names.length !== index.config.columns.length)
				throw new Error('Test fixture cannot omit an expression index')
			await pool.query(
				`CREATE ${index.config.unique ? 'UNIQUE ' : ''}INDEX ${quote(index.config.name)} ON ${quote(config.name)} (${names.join(',')})`,
			)
		}
	}
}

function barrier() {
	let release = () => {}
	const promise = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error('MySQL interleaving barrier timed out')),
			5000,
		)
		release = () => {
			clearTimeout(timer)
			resolve()
		}
	})
	return { promise, release }
}
function instrument<
	T extends Pool | Awaited<ReturnType<Pool['getConnection']>>,
>(client: T): T {
	preserveQueryResultShape(client)
	const original = client.query.bind(client)
	client.query = (async (...args: unknown[]) => {
		const first = args[0]
		const sql =
			typeof first === 'string'
				? first
				: first && typeof first === 'object' && 'sql' in first
					? String(first.sql)
					: ''
		const values = Array.isArray(args[1]) ? args[1] : []
		await state.beforeQuery?.(sql, values)
		const result = await Reflect.apply(original, client, args)
		await state.afterQuery?.(sql, values)
		return result
	}) as T['query']
	return client
}

suite('included products: real MySQL 8 RR and invoice redemption', () => {
	let pool: Pool
	let database: MySql2Database<typeof schema>
	let adapter: ReturnType<typeof DrizzleAdapter>
	const context = {
		purchaseId: 'direct',
		productId: 'product-s00zs',
		userId: 'learner',
		organizationId: 'personal-learner',
		organizationMembershipId: 'member-learner',
	}

	beforeAll(async () => {
		const parsed = new URL(uri!)
		if (
			!['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
			parsed.pathname !== '/c5_bundle_test'
		)
			throw new Error(
				'Only the owned loopback c5_bundle_test fixture is allowed',
			)
		pool = instrument(
			mysql.createPool({
				uri: uri!,
				connectionLimit: 6,
				timezone: 'Z',
				multipleStatements: true,
			}),
		)
		const getConnection = pool.getConnection.bind(pool)
		pool.getConnection = async () => instrument(await getConnection())
		await createFixtureSchema(pool)
		database = drizzle(pool, { schema, mode: 'planetscale' })
		state.database = database
		// SAFETY: the mysql2 tuple wrapper supplies the production rowsAffected,
		// rows and insertId fields; the adapter's table/transaction API is shared.
		const productionShape = database as unknown as typeof import('@/db').db
		adapter = DrizzleAdapter(productionShape, mysqlTable, {} as never)
		state.adapter = adapter
		const [[version]] = await pool.query<mysql.RowDataPacket[]>(
			'SELECT VERSION() AS version, @@transaction_isolation AS isolation',
		)
		expect(version!.version).toMatch(/^8\./)
		expect(version!.isolation).toBe('REPEATABLE-READ')
	}, 30000)

	beforeEach(async () => {
		state.beforeQuery = undefined
		state.afterQuery = undefined
		vi.clearAllMocks()
		for (const table of tables)
			await pool.query(`DELETE FROM ${quote(getTableName(table))}`)
		await database.insert(schema.users).values([
			{ id: 'owner', email: 'billing@example.test' },
			{ id: 'learner', email: 'learner@example.test' },
		])
		await database.insert(schema.organization).values({
			id: context.organizationId,
			name: 'Personal learner@example.test',
			personalOrganizationUserId: 'learner',
		})
		await database.insert(schema.organizationMemberships).values({
			id: context.organizationMembershipId,
			organizationId: context.organizationId,
			invitedById: 'owner',
			userId: 'learner',
		})
		await database.insert(schema.products).values([
			{
				id: 'product-s00zs',
				name: 'C5',
				type: 'cohort',
				status: 1,
				fields: { slug: 'c5-fixture' },
			},
			{
				id: 'product-ma254',
				name: 'Crash',
				type: 'self-paced',
				status: 1,
				fields: { slug: 'crash-fixture' },
			},
		])
		await database.insert(schema.contentResource).values([
			{
				id: 'workshop-2ozd9',
				type: 'workshop',
				fields: {},
				createdById: 'owner',
			},
			{ id: 'cohort-xdy1m', type: 'cohort', fields: {}, createdById: 'owner' },
			{ id: 'c5-workshop', type: 'workshop', fields: {}, createdById: 'owner' },
		])
		await database.insert(schema.contentResourceProduct).values([
			{ productId: 'product-ma254', resourceId: 'workshop-2ozd9' },
			{ productId: 'product-s00zs', resourceId: 'cohort-xdy1m' },
		])
		await database.insert(schema.entitlementTypes).values([
			{
				id: 'workshop-type',
				name: 'workshop_content_access',
				description: 'Workshop',
			},
			{
				id: 'cohort-type',
				name: 'cohort_content_access',
				description: 'Cohort',
			},
		])
	})
	afterAll(async () => {
		state.beforeQuery = undefined
		state.afterQuery = undefined
		await pool?.end()
	})

	async function order(charge: string) {
		return adapter.createMerchantChargeAndPurchase({
			userId: 'owner',
			productId: 'product-s00zs',
			stripeChargeId: charge,
			stripeChargeAmount: 19900,
			quantity: 3,
			merchantAccountId: 'merchant',
			merchantProductId: 'merchant-product',
			merchantCustomerId: 'merchant-customer',
			// The real paid-invoice handler persists invoice.id in this field.
			checkoutSessionId: `in_fixture_${charge}`,
			appliedPPPStripeCouponId: undefined,
			upgradedFromPurchaseId: undefined,
			usedCouponId: undefined,
		})
	}
	async function redeem(couponId: string) {
		const result = await adapter.redeemFullPriceCoupon({
			couponId,
			email: 'learner@example.test',
			currentUserId: 'learner',
			productIds: ['product-s00zs'],
			redeemingProductId: 'product-s00zs',
		})
		if (!result?.purchase) throw new Error('Fixture redemption failed')
		return result.purchase
	}
	async function fulfill(
		purchaseId: string,
		name = 'commerce/full-price-coupon-redeemed',
	) {
		const events: { name: string; data: unknown }[] = []
		const handler = (
			postPurchaseWorkflow as unknown as {
				handler: (args: Record<string, unknown>) => Promise<unknown>
			}
		).handler
		await handler({
			event: {
				name,
				data: { purchaseId, checkoutSessionId: null, productType: 'cohort' },
			},
			db: adapter,
			step: {
				run: async (_id: string, work: () => Promise<unknown>) => work(),
				sendEvent: async (
					_id: string,
					payload: { name: string; data: unknown },
				) => {
					events.push(payload)
				},
			},
			paymentProvider: { options: { paymentsAdapter: {} } },
			runId: 'mysql-fixture',
		})
		return events
	}
	async function live(purchaseId: string) {
		return (
			await database.query.entitlements.findMany({
				where: eq(schema.entitlements.sourceId, purchaseId),
			})
		).filter((row) => !row.deletedAt)
	}
	async function seatFixture() {
		const parent = await order('charge-1')
		const seat = await redeem(parent.bulkCouponId!)
		return { parent, seat, seatContext: { ...context, purchaseId: seat.id } }
	}

	it('creates an org-less paid invoice order, redeems through the real adapter, and writes both cohort and bundle rows', async () => {
		const { parent, seat } = await seatFixture()
		expect(parent.organizationId).toBeNull()
		const coupon = await database.query.coupon.findFirst({
			where: eq(schema.coupon.id, parent.bulkCouponId!),
		})
		expect(coupon!.organizationId).toBeNull()
		expect(seat.organizationId).toBe(context.organizationId)
		await fulfill(parent.id, 'commerce/new-purchase-created')
		await fulfill(seat.id)
		expect(
			(await live(seat.id)).map((row) => row.entitlementType).sort(),
		).toEqual(['cohort-type', 'workshop-type'])
		await database
			.insert(schema.users)
			.values({ id: 'later', email: 'later@example.test' })
		await database.insert(schema.organization).values({
			id: 'personal-later',
			name: 'Personal later@example.test',
			personalOrganizationUserId: 'later',
		})
		await database.insert(schema.organizationMemberships).values({
			id: 'member-later',
			userId: 'later',
			organizationId: 'personal-later',
			invitedById: 'owner',
		})
		const later = await adapter.redeemFullPriceCoupon({
			couponId: parent.bulkCouponId!,
			email: 'later@example.test',
			currentUserId: 'later',
			productIds: ['product-s00zs'],
			redeemingProductId: 'product-s00zs',
		})
		if (!later?.purchase)
			throw new Error('Later seat fixture redemption failed')
		expect(later.purchase.organizationId).toBe('personal-later')
		await fulfill(later.purchase.id)
		expect(
			(await live(later.purchase.id)).map((row) => row.entitlementType).sort(),
		).toEqual(['cohort-type', 'workshop-type'])
		expect(await live(parent.id)).toHaveLength(0)
	})
	it('redeems an added seat with two parents sharing the coupon, even with one parent refunded', async () => {
		const first = await order('charge-1')
		const added = await order('charge-2')
		expect(added.bulkCouponId).toBe(first.bulkCouponId)
		await database
			.update(schema.purchases)
			.set({ status: 'Refunded' })
			.where(eq(schema.purchases.id, first.id))
		const seat = await redeem(first.bulkCouponId!)
		await fulfill(seat.id)
		expect(await live(seat.id)).toHaveLength(2)
	})
	it('isolates real bundle contract failure after a real cohort grant and emits a retry request', async () => {
		const { seat } = await seatFixture()
		await database
			.delete(schema.contentResourceProduct)
			.where(eq(schema.contentResourceProduct.productId, 'product-ma254'))
		const events = await fulfill(seat.id)
		expect((await live(seat.id)).map((row) => row.entitlementType)).toEqual([
			'cohort-type',
		])
		expect(state.log.error).toHaveBeenCalledWith(
			'included_product.grant_failed',
			expect.objectContaining({
				purchaseId: seat.id,
				status: 'retry_requested',
			}),
		)
		expect(
			events.some(
				(event) =>
					event.name ===
					'commerce/included-product-entitlements-retry-requested',
			),
		).toBe(true)
	})
	it('serializes two concurrent first grants under real RR locks', async () => {
		const { seatContext, seat } = await seatFixture()
		await Promise.all([
			grantIncludedProductEntitlements(seatContext),
			grantIncludedProductEntitlements(seatContext),
		])
		expect(await live(seat.id)).toHaveLength(1)
	})
	it('grant first: refund waits for the parent PK lock, then removes the committed grant', async () => {
		const { parent, seat, seatContext } = await seatFixture()
		const locked = barrier(),
			release = barrier(),
			refundSent = barrier()
		state.afterQuery = async (sql, values) => {
			if (
				sql.includes('AI_Purchase') &&
				/for update/i.test(sql) &&
				values[0] === parent.id
			) {
				state.afterQuery = undefined
				locked.release()
				await release.promise
			}
		}
		const grant = grantIncludedProductEntitlements(seatContext)
		await locked.promise
		state.beforeQuery = async (sql, values) => {
			if (/^update/i.test(sql) && values.includes(parent.id)) {
				state.beforeQuery = undefined
				refundSent.release()
			}
		}
		const refund = refundBulkPurchaseEntitlements(parent)
		await refundSent.promise
		release.release()
		await Promise.all([grant, refund])
		expect(await live(seat.id)).toHaveLength(0)
	})
	it('refund first: a delayed grant reads current refunded state, not its RR discovery snapshot', async () => {
		const { parent, seat, seatContext } = await seatFixture()
		const locked = barrier(),
			release = barrier(),
			grantSent = barrier()
		state.afterQuery = async (sql, values) => {
			if (
				/^update/i.test(sql) &&
				sql.includes('AI_Purchase') &&
				values.includes(parent.id)
			) {
				state.afterQuery = undefined
				locked.release()
				await release.promise
			}
		}
		const refund = refundBulkPurchaseEntitlements(parent)
		await locked.promise
		state.beforeQuery = async (sql, values) => {
			if (/for update/i.test(sql) && values.includes(parent.id)) {
				state.beforeQuery = undefined
				grantSent.release()
			}
		}
		const outcome = grantIncludedProductEntitlements(seatContext).then(
			() => 'granted',
			() => 'rejected',
		)
		await grantSent.promise
		release.release()
		await refund
		expect(await outcome).toBe('rejected')
		expect(await live(seat.id)).toHaveLength(0)
	})
	it('records the existing redemption-mid-refund-enumeration gap rather than claiming it is fixed', async () => {
		const parent = await order('charge-1')
		const enumerated = barrier(),
			release = barrier()
		state.afterQuery = async (sql) => {
			if (/^select/i.test(sql) && sql.includes('redeemedBulkCouponId')) {
				state.afterQuery = undefined
				enumerated.release()
				await release.promise
			}
		}
		const refund = refundBulkPurchaseEntitlements(parent)
		await enumerated.promise
		const seat = await redeem(parent.bulkCouponId!)
		await grantIncludedProductEntitlements({ ...context, purchaseId: seat.id })
		release.release()
		await refund
		// A pre-enumerated refund misses a later seat. This remains a release
		// limitation of the shared refund helper; no broader fix is hidden here.
		expect(await live(seat.id)).toHaveLength(1)
		await expect(
			grantIncludedProductEntitlements({ ...context, purchaseId: seat.id }),
		).rejects.toThrow('seat origin')
	})
	it('records the individual refund-before-status/no-tombstone window', async () => {
		await database.insert(schema.purchases).values({
			id: context.purchaseId,
			userId: context.userId,
			productId: context.productId,
			organizationId: context.organizationId,
			totalAmount: '199',
		})
		await softDeleteEntitlementsForPurchase(context.purchaseId)
		await grantIncludedProductEntitlements(context)
		expect(await live(context.purchaseId)).toHaveLength(1)
	})
	it('applies the DR 44 SQL twice safely and EXPLAIN uses PRIMARY for locking discovery candidates', async () => {
		const { parent } = await seatFixture()
		const sql = await readFile(
			new URL(
				'../db/migrations/20261007_ai_hero_purchase_coupon_indexes.sql',
				import.meta.url,
			),
			'utf8',
		)
		await pool.query(sql)
		await pool.query(sql)
		const [plan] = await pool.query<mysql.RowDataPacket[]>(
			'EXPLAIN SELECT * FROM AI_Purchase WHERE id = ? FOR UPDATE',
			[parent.id],
		)
		expect(plan[0]!.key).toBe('PRIMARY')
		expect(plan[0]!.type).toBe('const')
		const [indexes] = await pool.query<mysql.RowDataPacket[]>(
			'SHOW INDEX FROM AI_Purchase',
		)
		expect(
			indexes.filter((row) =>
				[
					'idx_Purchase_on_bulkCouponId',
					'idx_Purchase_on_redeemedBulkCouponId',
				].includes(row.Key_name),
			),
		).toHaveLength(2)
		console.info(
			'C5_MYSQL_PK_EXPLAIN',
			JSON.stringify(
				plan.map((row) => ({ type: row.type, key: row.key, rows: row.rows })),
			),
		)
	})
})
