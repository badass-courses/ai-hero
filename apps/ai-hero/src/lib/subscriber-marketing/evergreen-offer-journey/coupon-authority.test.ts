import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { authorizeExclusiveCouponSelection } from '../../exclusive-coupon-authorization'
import { deadlineTimeZoneEvidenceFromHeader } from './calendar'
import { EVERGREEN_OFFER_JOURNEY_V1 } from './definition'
import type { BindCouponIntent, IssueCouponIntent } from './domain'
import {
	createCouponAuthority,
	semanticCouponId,
	type CommerceCouponRow,
	type CommerceEntitlementRow,
	type CommerceMerchantCouponRow,
	type CommerceUserRow,
	type CouponAuthorityOptions,
	type CouponCommerceStore,
	type CouponTransaction,
} from './coupon-authority'
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

function value<A>(parsed: ParseResult<A>): A {
	if (!parsed.ok) throw new Error('bad fixture')
	return parsed.value
}
const instant = (text: string) => value(parseIsoInstant(text))
const zone = deadlineTimeZoneEvidenceFromHeader({
	headerValue: 'America/Los_Angeles',
	capturedAt: instant('2026-09-01T00:00:00.000Z'),
})
if (!zone.ok) throw new Error('bad zone fixture')
const journeyId = value(parseJourneyId('evergreen-offer:fixture'))
const issue: IssueCouponIntent = {
	type: 'IssueCoupon',
	journeyId,
	contactId: value(parseContactId('contact-fixture')),
	idempotencyKey: couponIntentKey(journeyId),
	issueAt: instant('2026-09-10T16:00:00.000Z'),
	expiresAt: instant('2026-09-15T06:59:59.000Z'),
	deadlineTimeZone: zone.value,
	terms: EVERGREEN_OFFER_JOURNEY_V1.couponTerms,
}
const verifiedUserId = value(parseVerifiedUserId('user-fixture'))
const bind: BindCouponIntent = {
	type: 'BindCoupon',
	journeyId,
	contactId: issue.contactId,
	verifiedUserId,
	couponId: value(parseCouponId(semanticCouponId(issue.idempotencyKey))),
	idempotencyKey: couponBindingIntentKey({ journeyId, verifiedUserId }),
}
const evidence = {
	id: 'merchant-fixture',
	identifier: 'provider-fixture',
	merchantAccountId: 'account-fixture',
	currency: 'USD',
	amountOffCents: 10000,
	type: 'special',
	sourceReference: 'fixture-readback',
}
const merchant: CommerceMerchantCouponRow = {
	id: evidence.id,
	identifier: evidence.identifier,
	merchantAccountId: evidence.merchantAccountId,
	organizationId: null,
	status: 1,
	amountDiscount: 10000,
	percentageDiscount: null,
	type: 'special',
}
const user: CommerceUserRow = {
	id: verifiedUserId,
	name: null,
	role: 'user',
	email: 'fixture@example.test',
	fields: {},
	emailVerified: new Date('2026-09-01T00:00:00.000Z'),
	image: null,
	createdAt: new Date('2026-09-01T00:00:00.000Z'),
}
const proof = {
	type: 'VerifiedUserObserved',
	contactId: issue.contactId,
	journeyId,
	verifiedUserId,
	observedAt: '2026-09-10T16:00:00.000Z',
	sourceReference: 'fixture-auth-verification',
}

function fixture() {
	let coupons = new Map<string, CommerceCouponRow>()
	let grants = new Map<string, CommerceEntitlementRow>()
	let queue: Promise<unknown> = Promise.resolve()
	const state = {
		merchant: structuredClone(merchant),
		user: structuredClone(user),
		failAfterInsert: false,
		failBindingUpdate: false,
		clock: '2026-09-10T17:00:00.000Z',
		coupons: () => coupons,
		grants: () => grants,
	}
	const store: CouponCommerceStore = {
		withContactLock: <A>(
			_id: string,
			work: (tx: CouponTransaction) => Promise<A>,
		) => {
			const task = queue.then(async () => {
				const pendingCoupons = structuredClone(coupons)
				const pendingGrants = structuredClone(grants)
				const result = await work({
					getMerchantCoupon: async () => structuredClone(state.merchant),
					getCoupon: async (id) =>
						structuredClone(pendingCoupons.get(id) ?? null),
					insertCoupon: async (row) => {
						if (pendingCoupons.has(row.id)) throw new Error('duplicate')
						pendingCoupons.set(row.id, structuredClone(row))
						if (state.failAfterInsert)
							throw new Error('transaction interrupted')
					},
					setCouponFields: async (id, fields) => {
						if (state.failBindingUpdate) throw new Error('rollback binding')
						const row = pendingCoupons.get(id)
						if (!row) throw new Error('missing')
						pendingCoupons.set(id, { ...row, fields: structuredClone(fields) })
					},
					getUser: async (id) =>
						id === state.user.id ? structuredClone(state.user) : null,
					getCreditTypeId: async () => 'credit-type-fixture',
					listCouponEntitlements: async (id) =>
						[...pendingGrants.values()].filter(
							(grant) => grant.sourceId === id,
						),
					insertEntitlement: async (row) => {
						if (pendingGrants.has(row.id)) throw new Error('duplicate')
						pendingGrants.set(row.id, structuredClone(row))
					},
				})
				coupons = pendingCoupons
				grants = pendingGrants
				return result
			})
			queue = task.then(
				() => undefined,
				() => undefined,
			)
			return task
		},
	}
	const options: CouponAuthorityOptions = {
		store,
		merchantCouponEvidence: evidence,
		readVerifiedOwner: async () => proof,
		now: () => state.clock,
	}
	return { state, options, authority: createCouponAuthority(options) }
}
const result = <A>(effect: Effect.Effect<A, unknown>) =>
	Effect.runPromise(Effect.either(effect))
const permanent = { _tag: 'Left', left: { type: 'EffectPermanentRefusal' } }

describe('dormant coupon authority', () => {
	it('issues exact canonical terms/timestamps and one coupon under replay/concurrency', async () => {
		const { authority, state } = fixture()
		const receipts = await Promise.all(
			Array.from({ length: 6 }, () =>
				Effect.runPromise(authority.issue(issue)),
			),
		)
		expect(
			new Set(receipts.map((receipt) => receipt.coupon.couponId)).size,
		).toBe(1)
		expect(state.coupons().size).toBe(1)
		expect(receipts[0]?.coupon).toMatchObject({
			contactId: issue.contactId,
			issuedAt: issue.issueAt,
			expiresAt: issue.expiresAt,
			terms: issue.terms,
			binding: { type: 'AwaitingVerifiedUser' },
		})
		expect(state.coupons().get(bind.couponId)).toMatchObject({
			code: null,
			organizationId: null,
			amountDiscount: 10000,
			maxUses: 1,
			restrictedToProductId: 'product-ma254',
			fields: { exclusive: true },
		})
	})
	it('does not overwrite a semantic key with different owner or expiry', async () => {
		const { authority, state } = fixture()
		await Effect.runPromise(authority.issue(issue))
		for (const changed of [
			{ ...issue, contactId: value(parseContactId('other-contact')) },
			{ ...issue, expiresAt: instant('2026-09-16T06:59:59.000Z') },
		])
			expect(await result(authority.issue(changed))).toMatchObject(permanent)
		expect(state.coupons().size).toBe(1)
	})
	it.each(['productId', 'amountOffCents', 'currency', 'maxUses', 'exclusive'])(
		'refuses changed domain term %s',
		async (field) => {
			const { authority } = fixture()
			const altered = { ...issue, terms: { ...issue.terms } }
			Object.assign(altered.terms, {
				[field]: field === 'amountOffCents' ? 9999 : 'other',
			})
			expect(await result(authority.issue(altered))).toMatchObject(permanent)
		},
	)
	it.each([
		'amountDiscount',
		'type',
		'identifier',
		'merchantAccountId',
		'status',
	])('refuses mismatched merchant %s', async (field) => {
		const { authority, state } = fixture()
		Object.assign(state.merchant, { [field]: field === 'status' ? 0 : 'wrong' })
		expect(await result(authority.issue(issue))).toMatchObject(permanent)
		expect(state.coupons().size).toBe(0)
	})
	it('requires explicit currency evidence and never creates a merchant coupon', async () => {
		const { options, state } = fixture()
		const authority = createCouponAuthority({
			...options,
			merchantCouponEvidence: { ...evidence, currency: 'EUR' },
		})
		expect(await result(authority.issue(issue))).toMatchObject(permanent)
		expect(state.coupons().size).toBe(0)
	})
	it('rolls back failed issue and binding without orphan grants', async () => {
		const { authority, state } = fixture()
		state.failAfterInsert = true
		expect(await result(authority.issue(issue))).toMatchObject({
			_tag: 'Left',
			left: { type: 'EffectAmbiguous' },
		})
		expect(state.coupons().size).toBe(0)
		state.failAfterInsert = false
		await Effect.runPromise(authority.issue(issue))
		state.failBindingUpdate = true
		expect(await result(authority.bind(bind))).toMatchObject({
			_tag: 'Left',
			left: { type: 'EffectAmbiguous' },
		})
		expect(state.grants().size).toBe(0)
		state.failBindingUpdate = false
		expect(
			(await Effect.runPromise(authority.bind(bind))).coupon.binding.type,
		).toBe('BoundToVerifiedUser')
	})
	it('binds the same coupon once to verified owner; retry never changes expiry/boundAt', async () => {
		const { authority, state } = fixture()
		await Effect.runPromise(authority.issue(issue))
		const first = await Effect.runPromise(authority.bind(bind))
		state.clock = '2026-09-11T17:00:00.000Z'
		const second = await Effect.runPromise(authority.bind(bind))
		expect(second).toEqual(first)
		expect(first.coupon.couponId).toBe(bind.couponId)
		expect(first.coupon.expiresAt).toBe(issue.expiresAt)
		expect(state.grants().size).toBe(1)
		expect([...state.grants().values()][0]).toMatchObject({
			userId: verifiedUserId,
			sourceType: 'COUPON',
			sourceId: bind.couponId,
			entitlementType: 'credit-type-fixture',
			expiresAt: new Date(issue.expiresAt),
			organizationId: null,
		})
	})
	it('missing proof, wrong proof owner, and unverified actual User all refuse', async () => {
		const { options, authority, state } = fixture()
		await Effect.runPromise(authority.issue(issue))
		for (const reader of [
			undefined,
			async () => ({ ...proof, contactId: 'other' }),
			async () => ({ ...proof, verifiedUserId: 'other' }),
			async () => null,
		]) {
			expect(
				await result(
					createCouponAuthority({ ...options, readVerifiedOwner: reader }).bind(
						bind,
					),
				),
			).toMatchObject(permanent)
		}
		state.user.emailVerified = null
		expect(await result(authority.bind(bind))).toMatchObject(permanent)
		expect(state.grants().size).toBe(0)
	})
	it('never rebinds an issued coupon even with a later verified account association', async () => {
		const { authority, options, state } = fixture()
		await Effect.runPromise(authority.issue(issue))
		await Effect.runPromise(authority.bind(bind))
		const otherUser = value(parseVerifiedUserId('other-verified-user'))
		state.user = { ...state.user, id: otherUser }
		const changedAuthority = createCouponAuthority({
			...options,
			readVerifiedOwner: async () => ({ ...proof, verifiedUserId: otherUser }),
		})
		expect(
			await result(
				changedAuthority.bind({
					...bind,
					verifiedUserId: otherUser,
					idempotencyKey: couponBindingIntentKey({
						journeyId,
						verifiedUserId: otherUser,
					}),
				}),
			),
		).toMatchObject(permanent)
		expect([...state.grants().values()].map((grant) => grant.userId)).toEqual([
			verifiedUserId,
		])
	})
	it('concurrent different user binds only permit the verified owner', async () => {
		const { authority, state } = fixture()
		await Effect.runPromise(authority.issue(issue))
		const otherUser = value(parseVerifiedUserId('other-user'))
		const outcomes = await Promise.all([
			result(
				authority.bind({
					...bind,
					verifiedUserId: otherUser,
					idempotencyKey: couponBindingIntentKey({
						journeyId,
						verifiedUserId: otherUser,
					}),
				}),
			),
			result(authority.bind(bind)),
		])
		expect(outcomes[0]).toMatchObject(permanent)
		expect(outcomes[1]._tag).toBe('Right')
		expect(state.grants().size).toBe(1)
	})
	it.each(['expired', 'revoked', 'used', 'wrong-product', 'changed-expiry'])(
		'refuses %s coupons, never extends or replaces them',
		async (scenario) => {
			const { authority, state } = fixture()
			await Effect.runPromise(authority.issue(issue))
			const row = state.coupons().get(bind.couponId)
			if (!row) throw new Error('missing')
			if (scenario === 'expired') state.clock = issue.expiresAt
			if (scenario === 'revoked') row.status = 0
			if (scenario === 'used') row.usedCount = 1
			if (scenario === 'wrong-product') row.restrictedToProductId = 'other'
			if (scenario === 'changed-expiry')
				row.expires = new Date('2026-10-01T00:00:00.000Z')
			expect(await result(authority.bind(bind))).toMatchObject(permanent)
			expect(state.grants().size).toBe(0)
		},
	)
	it('refuses a revoked entitlement instead of recreating it', async () => {
		const { authority, state } = fixture()
		await Effect.runPromise(authority.issue(issue))
		await Effect.runPromise(authority.bind(bind))
		for (const grant of state.grants().values())
			grant.deletedAt = new Date(state.clock)
		expect(await result(authority.bind(bind))).toMatchObject(permanent)
		expect(state.grants().size).toBe(1)
	})
	it('existing exclusive authorizer accepts only correct user/product/individual quantity before expiry', async () => {
		const { authority, state } = fixture()
		await Effect.runPromise(authority.issue(issue))
		await Effect.runPromise(authority.bind(bind))
		const adapter = {
			getMerchantCoupon: async () => state.merchant,
			getCoupon: async (id: string) => state.coupons().get(id) ?? null,
			getEntitlementTypeByName: async () => ({ id: 'credit-type-fixture' }),
			getEntitlementsForUser: async () => [...state.grants().values()],
		}
		for (const [userId, productId, quantity, clock, expected] of [
			[verifiedUserId, 'product-ma254', 1, state.clock, true],
			['other', 'product-ma254', 1, state.clock, false],
			[verifiedUserId, 'other', 1, state.clock, false],
			[verifiedUserId, 'product-ma254', 2, state.clock, false],
			[verifiedUserId, 'product-ma254', 1, issue.expiresAt, false],
		] as const) {
			const decision = await authorizeExclusiveCouponSelection({
				adapter,
				verifiedUserId: userId,
				productId,
				quantity,
				requestedSiteCouponId: bind.couponId,
				requestedMerchantCouponId: evidence.id,
				now: new Date(clock),
			})
			expect(decision.authorized).toBe(expected)
		}
	})
})
