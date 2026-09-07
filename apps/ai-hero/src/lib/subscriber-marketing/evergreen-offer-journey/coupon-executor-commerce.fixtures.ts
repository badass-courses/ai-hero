import { Effect } from 'effect'
import { drizzle } from 'drizzle-orm/mysql2'
import type { Pool } from 'mysql2/promise'
import { eq } from 'drizzle-orm'
import { expect } from 'vitest'
import * as journeySchema from '@/db/evergreen-offer-journey-schema'
import { authorizeExclusiveCouponSelection } from '../../exclusive-coupon-authorization'
import {
	createCouponAuthority,
	type CouponCommerceStore,
} from './coupon-authority'
import {
	couponCommerceSchema,
	createMySqlCouponCommerceStore,
	createMySqlCouponReceiptReadStore,
} from './coupon-authority-mysql'
import { createCouponReceiptReader } from './coupon-receipt-reader'
import { createCouponIntentExecutor } from './coupon-executor'
import { couponExecutorFixture } from './coupon-executor.fixtures'
import { parseVerifiedUserId, parseStimulusId } from './primitives'
import { decodeAttempt } from './attempt-evidence'
import type { EvergreenOfferStimulus } from './domain'

// Same six-table projection and uniqueness boundaries as coupon-authority.mysql.test.ts.
// Test-owned DDL only, executed inside the existing randomly named disposable database.
export const commerceTables = [
	'AI_Entitlement',
	'AI_Coupon',
	'AI_MerchantCoupon',
	'AI_EntitlementType',
	'AI_User',
	'AI_Contact',
]
export const commerceDdl = [
	'CREATE TABLE AI_Contact (id varchar(255) NOT NULL PRIMARY KEY, email varchar(255))',
	'CREATE TABLE AI_MerchantCoupon (id varchar(191) NOT NULL PRIMARY KEY, identifier varchar(191) UNIQUE, organizationId varchar(191), status int NOT NULL DEFAULT 0, merchantAccountId varchar(191) NOT NULL, percentageDiscount decimal(3,2), amountDiscount int, type varchar(191))',
	'CREATE TABLE AI_Coupon (id varchar(191) NOT NULL PRIMARY KEY, organizationId varchar(191), code varchar(191) UNIQUE, createdAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), expires timestamp(3) NULL, fields json, maxUses int NOT NULL DEFAULT -1, `default` boolean NOT NULL DEFAULT false, merchantCouponId varchar(191), status int NOT NULL DEFAULT 0, usedCount int NOT NULL DEFAULT 0, percentageDiscount decimal(3,2), amountDiscount int, restrictedToProductId varchar(191), INDEX Coupon_id_code_index(id,code))',
	'CREATE TABLE AI_User (id varchar(255) NOT NULL PRIMARY KEY, name varchar(255), role varchar(191) NOT NULL DEFAULT "user", email varchar(255) NOT NULL UNIQUE, fields json, emailVerified timestamp(3) NULL, image varchar(255), createdAt timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3))',
	'CREATE TABLE AI_EntitlementType (id varchar(191) NOT NULL PRIMARY KEY, name varchar(255) NOT NULL UNIQUE, description text)',
	'CREATE TABLE AI_Entitlement (id varchar(191) NOT NULL PRIMARY KEY, entitlementType varchar(255) NOT NULL, userId varchar(191), organizationId varchar(191), organizationMembershipId varchar(191), sourceType varchar(255) NOT NULL, sourceId varchar(191) NOT NULL, metadata json, expiresAt timestamp(3) NULL, createdAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), deletedAt timestamp(3) NULL, INDEX source_idx(sourceType,sourceId))',
]

export async function realCommerceFixture(
	pool: Pool,
	real: NonNullable<Parameters<typeof couponExecutorFixture>[0]>,
) {
	const f = await couponExecutorFixture(real)
	const queries: string[] = []
	const database = drizzle(pool, {
		schema: couponCommerceSchema,
		mode: 'default',
		logger: {
			logQuery: (query) => {
				queries.push(query)
			},
		},
	})
	const journeyDb = drizzle(pool, { schema: journeySchema, mode: 'default' })
	const parsedUser = parseVerifiedUserId('real-commerce-user')
	const parsedStimulus = parseStimulusId('real-commerce-verified-fixture')
	if (!parsedUser.ok || !parsedStimulus.ok)
		throw new Error('Invalid fixture identity')
	const userId = parsedUser.value
	const verifiedStimulusId = parsedStimulus.value
	const merchant = {
		id: 'real-commerce-merchant',
		identifier: 'synthetic-provider',
		merchantAccountId: 'synthetic-account',
		currency: 'USD',
		amountOffCents: 10000,
		type: 'special',
		sourceReference: 'synthetic-merchant-evidence-not-provider-proof',
	}
	const syntheticEmail = 'real-commerce@example.test'
	await pool.query('INSERT INTO AI_Contact(id, email) VALUES (?, ?)', [
		f.issue.contactId,
		syntheticEmail,
	])
	await database.insert(couponCommerceSchema.merchantCoupon).values({
		id: merchant.id,
		identifier: merchant.identifier,
		merchantAccountId: merchant.merchantAccountId,
		amountDiscount: merchant.amountOffCents,
		status: 1,
		type: merchant.type,
	})
	await database.insert(couponCommerceSchema.users).values({
		id: userId,
		email: syntheticEmail,
		emailVerified: new Date(f.issue.issueAt),
	})
	await database
		.insert(couponCommerceSchema.entitlementTypes)
		.values({ id: 'real-credit-type', name: 'apply_special_credit' })
	const fault = { loseResponse: false, failDomain: false }
	const calls = { issue: 0, bind: 0, commits: 0 }
	const committed: unknown[] = []
	const stimuli: EvergreenOfferStimulus[] = []
	const root = createMySqlCouponCommerceStore(database)
	const store: CouponCommerceStore = {
		withContactLock: async (id, work) => {
			const result = await root.withContactLock(id, work)
			// The concrete store only resolves after installed Drizzle awaited COMMIT.
			calls.commits++
			committed.push(structuredClone(result))
			if (fault.loseResponse) {
				fault.loseResponse = false
				throw new Error('synthetic process-loss boundary after real COMMIT')
			}
			return result
		},
	}
	const authority = createCouponAuthority({
		store,
		merchantCouponEvidence: merchant,
		now: f.getNow,
		readVerifiedOwner: async (query) => {
			expect(query.contactId).toBe(f.issue.contactId)
			expect(query.journeyId).toBe(f.issue.journeyId)
			expect(query.verifiedUserId).toBe(userId)
			expect(query.lockedContact).toEqual({
				id: f.issue.contactId,
				email: syntheticEmail,
			})
			expect(query.lockedUser).toEqual({
				id: userId,
				email: syntheticEmail,
				emailVerified: f.issue.issueAt,
			})
			expect(Object.isFrozen(query.lockedContact)).toBe(true)
			expect(Object.isFrozen(query.lockedUser)).toBe(true)
			// Only synthetic evidence, after asserting the real locked snapshots.
			return {
				type: 'VerifiedUserObserved',
				journeyId: f.issue.journeyId,
				contactId: f.issue.contactId,
				verifiedUserId: userId,
				observedAt: f.issue.issueAt,
				sourceReference: 'synthetic-verified-owner-evidence-not-auth-proof',
			}
		},
	})
	const reader = createCouponReceiptReader(
		createMySqlCouponReceiptReadStore(database),
	)
	const executor = createCouponIntentExecutor({
		...f.dependencies,
		receipts: reader,
		coupons: {
			issue: (intent) =>
				Effect.suspend(() => {
					calls.issue++
					return authority.issue(intent)
				}),
			bind: (intent) =>
				Effect.suspend(() => {
					calls.bind++
					return authority.bind(intent)
				}),
		},
		service: {
			advance: (stimulus) =>
				Effect.suspend(() => {
					stimuli.push(structuredClone(stimulus))
					return fault.failDomain
						? Effect.fail({
								type: 'JourneyCommitUnavailable',
								reason: 'synthetic before domain COMMIT',
							})
						: f.service.advance(stimulus)
				}),
		},
	})
	async function snapshot() {
		return {
			coupons: await database.select().from(couponCommerceSchema.coupon),
			grants: await database.select().from(couponCommerceSchema.entitlements),
		}
	}
	async function attempt(key: string) {
		const rows = await journeyDb
			.select()
			.from(journeySchema.evergreenOfferJourneyAttempt)
			.where(eq(journeySchema.evergreenOfferJourneyAttempt.idempotencyKey, key))
		expect(rows).toHaveLength(1)
		return decodeAttempt(rows[0])
	}
	async function binding() {
		f.setNow(new Date(Date.parse(f.getNow()) + 2000).toISOString())
		const result = await Effect.runPromise(
			f.service.advance({
				type: 'VerifiedUserObserved',
				stimulusId: verifiedStimulusId,
				journeyId: f.issue.journeyId,
				verifiedUserId: userId,
				observedAt: f.getNow(),
				sourceReference: 'synthetic-verified-owner-evidence-not-auth-proof',
			}),
		)
		expect(result.committed).toBe(true)
		const view = await Effect.runPromise(
			f.ledger.inspect({
				journeyId: f.issue.journeyId,
				now: f.getNow(),
				automationControl: 'Enabled',
			}),
		)
		const intent = view.intents.find(
			(row) => row.intent.type === 'BindCoupon',
		)?.intent
		if (!intent || intent.type !== 'BindCoupon')
			throw new Error('Missing canonical binding intent')
		return intent
	}
	async function gate() {
		const rows = await snapshot()
		const merchants = await database
			.select()
			.from(couponCommerceSchema.merchantCoupon)
		if (!rows.coupons[0]) throw new Error('Missing coupon')
		return authorizeExclusiveCouponSelection({
			adapter: {
				getCoupon: async () => rows.coupons[0] ?? null,
				getMerchantCoupon: async () => merchants[0] ?? null,
				getEntitlementTypeByName: async () => ({ id: 'real-credit-type' }),
				getEntitlementsForUser: async () => rows.grants,
			},
			verifiedUserId: userId,
			quantity: 1,
			productId: f.issue.terms.productId,
			requestedSiteCouponId: rows.coupons[0].id,
			requestedMerchantCouponId: merchant.id,
			now: new Date(f.getNow()),
		})
	}
	return {
		...f,
		executor,
		reader,
		database,
		fault,
		calls,
		committed,
		stimuli,
		queries,
		userId,
		snapshot,
		attempt,
		binding,
		gate,
	}
}
