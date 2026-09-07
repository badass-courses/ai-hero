import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { validateMySqlIntegrationServerUrl } from '../../team-purchase-mysql-test-guard'
import { authorizeExclusiveCouponSelection } from '../../exclusive-coupon-authorization'
import { deadlineTimeZoneEvidenceFromHeader } from './calendar'
import { EVERGREEN_OFFER_JOURNEY_V1 } from './definition'
import {
	createCouponAuthority,
	semanticCouponId,
	type CouponAuthorityOptions,
	type CouponCommerceStore,
} from './coupon-authority'
import {
	couponCommerceSchema,
	createMySqlCouponCommerceStore,
	type CouponCommerceDatabase,
} from './coupon-authority-mysql'
import {
	couponBindingIntentKey,
	couponIntentKey,
	parseContactId,
	parseCouponId,
	parseIsoInstant,
	parseJourneyId,
	parseVerifiedUserId,
	type ParseResult,
} from './primitives'
import type { BindCouponIntent, IssueCouponIntent } from './domain'

const serverUrl = process.env.AIH_EVERGREEN_COUPON_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!serverUrl)
const tables = [
	'AI_Entitlement',
	'AI_Coupon',
	'AI_MerchantCoupon',
	'AI_EntitlementType',
	'AI_User',
	'AI_Contact',
]
// Mirrors only the six commerce tables used here, including their uniqueness boundaries.
const ddl = [
	'CREATE TABLE AI_Contact (id varchar(255) NOT NULL PRIMARY KEY)',
	'CREATE TABLE AI_MerchantCoupon (id varchar(191) NOT NULL PRIMARY KEY, identifier varchar(191) UNIQUE, organizationId varchar(191), status int NOT NULL DEFAULT 0, merchantAccountId varchar(191) NOT NULL, percentageDiscount decimal(3,2), amountDiscount int, type varchar(191))',
	'CREATE TABLE AI_Coupon (id varchar(191) NOT NULL PRIMARY KEY, organizationId varchar(191), code varchar(191) UNIQUE, createdAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), expires timestamp(3) NULL, fields json, maxUses int NOT NULL DEFAULT -1, `default` boolean NOT NULL DEFAULT false, merchantCouponId varchar(191), status int NOT NULL DEFAULT 0, usedCount int NOT NULL DEFAULT 0, percentageDiscount decimal(3,2), amountDiscount int, restrictedToProductId varchar(191), INDEX Coupon_id_code_index(id,code))',
	'CREATE TABLE AI_User (id varchar(255) NOT NULL PRIMARY KEY, name varchar(255), role varchar(191) NOT NULL DEFAULT "user", email varchar(255) NOT NULL UNIQUE, fields json, emailVerified timestamp(3) NULL, image varchar(255), createdAt timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3))',
	'CREATE TABLE AI_EntitlementType (id varchar(191) NOT NULL PRIMARY KEY, name varchar(255) NOT NULL UNIQUE, description text)',
	'CREATE TABLE AI_Entitlement (id varchar(191) NOT NULL PRIMARY KEY, entitlementType varchar(255) NOT NULL, userId varchar(191), organizationId varchar(191), organizationMembershipId varchar(191), sourceType varchar(255) NOT NULL, sourceId varchar(191) NOT NULL, metadata json, expiresAt timestamp(3) NULL, createdAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), deletedAt timestamp(3) NULL, INDEX source_idx(sourceType,sourceId))',
]
function value<A>(parsed: ParseResult<A>): A {
	if (!parsed.ok) throw new Error('bad fixture')
	return parsed.value
}
const instant = (text: string) => value(parseIsoInstant(text))
const journeyId = value(parseJourneyId('evergreen-offer:mysql-fixture'))
const userId = value(parseVerifiedUserId('mysql-user'))
const contactId = value(parseContactId('mysql-contact'))
const zone = deadlineTimeZoneEvidenceFromHeader({
	headerValue: 'America/Los_Angeles',
	capturedAt: instant('2026-09-01T00:00:00.000Z'),
})
if (!zone.ok) throw new Error('bad zone')
const issue: IssueCouponIntent = {
	type: 'IssueCoupon',
	journeyId,
	contactId,
	idempotencyKey: couponIntentKey(journeyId),
	issueAt: instant('2026-09-10T16:00:00.000Z'),
	expiresAt: instant('2026-09-15T06:59:59.000Z'),
	deadlineTimeZone: zone.value,
	terms: EVERGREEN_OFFER_JOURNEY_V1.couponTerms,
}
const bind: BindCouponIntent = {
	type: 'BindCoupon',
	journeyId,
	contactId,
	verifiedUserId: userId,
	couponId: value(parseCouponId(semanticCouponId(issue.idempotencyKey))),
	idempotencyKey: couponBindingIntentKey({ journeyId, verifiedUserId: userId }),
}
const evidence = {
	id: 'mysql-merchant',
	identifier: 'mysql-provider',
	merchantAccountId: 'mysql-account',
	currency: 'USD',
	amountOffCents: 10000,
	type: 'special',
	sourceReference: 'disposable-fixture-readback',
}

integration('coupon authority disposable MySQL', () => {
	let server: Pool | undefined
	let pool: Pool | undefined
	let ownedDatabase: string | undefined
	let database: CouponCommerceDatabase
	let store: CouponCommerceStore
	const options = (): CouponAuthorityOptions => ({
		store,
		merchantCouponEvidence: evidence,
		now: () => '2026-09-10T17:00:00.000Z',
		readVerifiedOwner: async () => ({
			type: 'VerifiedUserObserved',
			contactId,
			journeyId,
			verifiedUserId: userId,
			observedAt: '2026-09-10T16:00:00.000Z',
			sourceReference: 'disposable-verified-auth',
		}),
	})
	beforeAll(async () => {
		if (!serverUrl) throw new Error('missing disposable server')
		const url = validateMySqlIntegrationServerUrl(serverUrl)
		server = mysql.createPool(url.toString())
		const name = `aih_coupon_test_${randomUUID().replaceAll('-', '')}`
		await server.query(
			`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
		)
		ownedDatabase = name
		pool = mysql.createPool({
			host: url.hostname,
			port: Number(url.port),
			user: decodeURIComponent(url.username),
			password: decodeURIComponent(url.password),
			database: name,
			timezone: 'Z',
			connectionLimit: 10,
		})
		for (const statement of ddl) await pool.query(statement)
		database = drizzle(pool, { schema: couponCommerceSchema, mode: 'default' })
		store = createMySqlCouponCommerceStore(database)
	})
	afterAll(async () => {
		await pool?.end()
		if (server && ownedDatabase)
			await server.query(`DROP DATABASE \`${ownedDatabase}\``)
		await server?.end()
	})
	beforeEach(async () => {
		if (!pool) throw new Error('missing pool')
		for (const table of tables) await pool.query(`DELETE FROM \`${table}\``)
		await pool.query('INSERT INTO AI_Contact(id) VALUES (?)', [contactId])
		await database.insert(couponCommerceSchema.merchantCoupon).values({
			id: evidence.id,
			identifier: evidence.identifier,
			merchantAccountId: evidence.merchantAccountId,
			amountDiscount: 10000,
			status: 1,
			type: 'special',
		})
		await database.insert(couponCommerceSchema.users).values({
			id: userId,
			email: 'fixture@example.test',
			emailVerified: new Date('2026-09-01T00:00:00.000Z'),
		})
		await database
			.insert(couponCommerceSchema.entitlementTypes)
			.values({ id: 'mysql-credit-type', name: 'apply_special_credit' })
	})
	it('serializes concurrent issuance and binding into one persisted coupon and entitlement', async () => {
		const authority = createCouponAuthority(options())
		const issued = await Promise.all(
			Array.from({ length: 6 }, () =>
				Effect.runPromise(authority.issue(issue)),
			),
		)
		expect(new Set(issued.map((receipt) => receipt.coupon.couponId)).size).toBe(
			1,
		)
		const bound = await Promise.all(
			Array.from({ length: 6 }, () => Effect.runPromise(authority.bind(bind))),
		)
		expect(
			new Set(bound.map((receipt) => receipt.providerReceiptId)).size,
		).toBe(1)
		const rows = await database.select().from(couponCommerceSchema.coupon)
		const grants = await database
			.select()
			.from(couponCommerceSchema.entitlements)
		expect(rows).toHaveLength(1)
		expect(grants).toHaveLength(1)
		expect(rows[0]?.createdAt.toISOString()).toBe(issue.issueAt)
		expect(rows[0]?.expires?.toISOString()).toBe(issue.expiresAt)
		expect(grants[0]?.expiresAt?.toISOString()).toBe(issue.expiresAt)
	})
	it('rolls back transaction failure after insert with no orphan coupon', async () => {
		const failingStore: CouponCommerceStore = {
			withContactLock: (id, work) =>
				store.withContactLock(id, async (tx) => {
					await work(tx)
					throw new Error('disposable rollback')
				}),
		}
		const outcome = await Effect.runPromise(
			Effect.either(
				createCouponAuthority({ ...options(), store: failingStore }).issue(
					issue,
				),
			),
		)
		expect(outcome).toMatchObject({
			_tag: 'Left',
			left: { type: 'EffectAmbiguous' },
		})
		expect(
			await database.select().from(couponCommerceSchema.coupon),
		).toHaveLength(0)
	})
	it('refuses concurrent wrong-user bind and enforces resulting entitlement at existing checkout gate', async () => {
		const authority = createCouponAuthority(options())
		await Effect.runPromise(authority.issue(issue))
		const wrongUser = value(parseVerifiedUserId('wrong-user'))
		const attempts = await Promise.all([
			Effect.runPromise(
				Effect.either(
					authority.bind({
						...bind,
						verifiedUserId: wrongUser,
						idempotencyKey: couponBindingIntentKey({
							journeyId,
							verifiedUserId: wrongUser,
						}),
					}),
				),
			),
			Effect.runPromise(Effect.either(authority.bind(bind))),
		])
		expect(attempts[0]).toMatchObject({
			_tag: 'Left',
			left: { type: 'EffectPermanentRefusal' },
		})
		expect(attempts[1]._tag).toBe('Right')
		const coupons = await database.select().from(couponCommerceSchema.coupon)
		const merchants = await database
			.select()
			.from(couponCommerceSchema.merchantCoupon)
		const grants = await database
			.select()
			.from(couponCommerceSchema.entitlements)
		const adapter = {
			getCoupon: async (id: string) =>
				coupons.find((row) => row.id === id) ?? null,
			getMerchantCoupon: async () => merchants[0] ?? null,
			getEntitlementTypeByName: async () => ({ id: 'mysql-credit-type' }),
			getEntitlementsForUser: async () => grants,
		}
		for (const [verifiedUserId, quantity, expected] of [
			[userId, 1, true],
			[wrongUser, 1, false],
			[userId, 2, false],
		] as const) {
			const result = await authorizeExclusiveCouponSelection({
				adapter,
				verifiedUserId,
				quantity,
				productId: issue.terms.productId,
				requestedSiteCouponId: bind.couponId,
				requestedMerchantCouponId: evidence.id,
				now: new Date('2026-09-10T17:00:00.000Z'),
			})
			expect(result.authorized).toBe(expected)
		}
	})
})
