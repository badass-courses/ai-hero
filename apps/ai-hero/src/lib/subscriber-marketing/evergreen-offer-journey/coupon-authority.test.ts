import { Effect } from 'effect'
import { createCouponReceiptReader } from './coupon-receipt-reader'
import {
	validatePersistedCommitEvidenceEnvelope,
	EVERGREEN_OFFER_JOURNEY_COMMIT_EVIDENCE_FORMAT,
} from './persistence-codec'
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
		responseLost: false,
		transactions: 0,
		committedResults: new Array<unknown>(),
		clock: '2026-09-10T17:00:00.000Z',
		coupons: () => coupons,
		grants: () => grants,
	}
	const store: CouponCommerceStore = {
		withContactLock: <A>(
			_id: string,
			work: (tx: CouponTransaction) => Promise<A>,
		) => {
			state.transactions++
			const task = queue.then(async () => {
				const pendingCoupons = structuredClone(coupons)
				const pendingGrants = structuredClone(grants)
				const result = await work({
					lockedContact: { id: issue.contactId, email: user.email },
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
				state.committedResults.push(structuredClone(result))
				if (state.responseLost) throw new Error('committed-response-lost')
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
	const reads = { calls: 0 }
	const reader = createCouponReceiptReader({
		getCoupon: async (id) => {
			reads.calls++
			return structuredClone(coupons.get(id) ?? null)
		},
		getCreditTypeId: async () => {
			reads.calls++
			return 'credit-type-fixture'
		},
		listCouponEntitlements: async (id) => {
			reads.calls++
			return structuredClone(
				[...grants.values()].filter((grant) => grant.sourceId === id),
			)
		},
	})
	return {
		state,
		options,
		reader,
		reads,
		authority: createCouponAuthority(options),
	}
}
const result = <A>(effect: Effect.Effect<A, unknown>) =>
	Effect.runPromise(Effect.either(effect))
const permanent = { _tag: 'Left', left: { type: 'EffectPermanentRefusal' } }

describe('locked verified-owner callback', () => {
	it('locks User before invoking proof and passes immutable identity snapshots', async () => {
		const f = fixture()
		const order: string[] = []
		const authority = createCouponAuthority({
			...f.options,
			store: {
				withContactLock: (id, work) => f.options.store.withContactLock(id, tx => work({
					...tx,
					getUser: async id => { order.push('user-lock'); return tx.getUser(id) },
				})),
			},
			readVerifiedOwner: async input => {
				order.push('proof')
				expect(input.lockedUser).toEqual({ id: user.id, email: user.email, emailVerified: user.emailVerified!.toISOString() })
				expect(input.lockedContact).toEqual({ id: issue.contactId, email: user.email })
				expect(Object.isFrozen(input.lockedUser)).toBe(true)
				expect(Object.isFrozen(input.lockedContact)).toBe(true)
				expect(input.couponId).toBe(bind.couponId)
				return proof
			},
		})
		await Effect.runPromise(authority.issue(issue))
		await Effect.runPromise(authority.bind(bind))
		expect(order).toEqual(['user-lock', 'proof'])
	})
	it('translates proof read failure to transient unavailable, not missing proof or ambiguous grant', async () => {
		const f = fixture()
		await Effect.runPromise(f.authority.issue(issue))
		const authority = createCouponAuthority({ ...f.options, readVerifiedOwner: async () => { throw new Error('db offline') } })
		expect(await result(authority.bind(bind))).toMatchObject({ _tag: 'Left', left: { type: 'EffectTransientUnavailable', reason: 'verified-owner-proof-unavailable' } })
		expect(f.state.grants().size).toBe(0)
	})
})

describe('historical receipt recovery, not authorization', () => {
	it.each(['expired', 'consumed', 'revoked-coupon', 'revoked-grant'])(
		'inspection never widens the exclusive authorizer for %s',
		async (stateName) => {
			const { authority, reader, state } = fixture()
			await Effect.runPromise(authority.issue(issue))
			await Effect.runPromise(authority.bind(bind))
			const row = state.coupons().get(bind.couponId)
			if (!row) throw new Error('missing coupon')
			if (stateName === 'expired') state.clock = issue.expiresAt
			if (stateName === 'consumed') row.usedCount = 1
			if (stateName === 'revoked-coupon') row.status = 0
			if (stateName === 'revoked-grant')
				for (const grant of state.grants().values())
					grant.deletedAt = new Date(state.clock)
			expect(
				await Effect.runPromise(reader.inspectBinding(bind)),
			).toMatchObject({ type: 'Recorded' })
			const gate = await authorizeExclusiveCouponSelection({
				adapter: {
					getCoupon: async () => row,
					getMerchantCoupon: async () => state.merchant,
					getEntitlementTypeByName: async () => ({ id: 'credit-type-fixture' }),
					getEntitlementsForUser: async () => [...state.grants().values()],
				},
				verifiedUserId,
				quantity: 1,
				productId: issue.terms.productId,
				requestedSiteCouponId: bind.couponId,
				requestedMerchantCouponId: evidence.id,
				now: new Date(state.clock),
			})
			expect(gate.authorized).toBe(false)
		},
	)
	it.each([1205, 1213])(
		'unproven code %s and nested rollback causes stay Ambiguous, with no retries',
		async (errno) => {
			const { options } = fixture()
			const driver = Object.assign(new Error('unproven rollback'), {
				errno,
				code: errno === 1205 ? 'ER_LOCK_WAIT_TIMEOUT' : 'ER_LOCK_DEADLOCK',
			})
			for (const error of [
				driver,
				new Error('commit/rollback response lost', { cause: driver }),
			]) {
				let calls = 0
				const authority = createCouponAuthority({
					...options,
					store: {
						withContactLock: async () => {
							calls++
							throw error
						},
					},
				})
				expect(await result(authority.issue(issue))).toMatchObject({
					_tag: 'Left',
					left: { type: 'EffectAmbiguous' },
				})
				expect(calls).toBe(1)
			}
		},
	)
	it('missing/unavailable rows and contradictory original issue evidence never grant retry permission', async () => {
		const { authority, reader, state } = fixture()
		expect(await Effect.runPromise(reader.inspectIssue(issue))).toMatchObject({
			type: 'Unknown',
		})
		await Effect.runPromise(authority.issue(issue))
		expect(
			await Effect.runPromise(
				reader.inspectIssue({
					...issue,
					contactId: value(parseContactId('wrong-owner')),
				}),
			),
		).toMatchObject({ type: 'Unknown' })
		const unavailable = createCouponReceiptReader({
			getCoupon: async () => {
				throw new Error('read lost')
			},
			getCreditTypeId: async () => null,
			listCouponEntitlements: async () => [],
		})
		expect(
			await Effect.runPromise(unavailable.inspectIssue(issue)),
		).toMatchObject({ type: 'Unknown' })
		expect(state.coupons().size).toBe(1)
		expect(state.grants().size).toBe(0)
	})
	it('recovers lost issue response after expiry with original receipt and no write', async () => {
		const { authority, reader, reads, state } = fixture()
		state.responseLost = true
		expect(await result(authority.issue(issue))).toMatchObject({
			_tag: 'Left',
			left: { type: 'EffectAmbiguous' },
		})
		state.clock = issue.expiresAt
		const before = structuredClone([...state.coupons()])
		const transactions = state.transactions
		const recovered = await Effect.runPromise(reader.inspectIssue(issue))
		expect(recovered).toMatchObject({
			type: 'Recorded',
			receipt: state.committedResults[0],
			operationObservedAt: { type: 'Known', at: '2026-09-10T17:00:00.000Z' },
		})
		expect(state.transactions).toBe(transactions)
		expect(reads.calls).toBe(1)
		expect([...state.coupons()]).toEqual(before)
	})
	it('recovers original issue after binding and coherent revoked/consumed binding evidence without resurrection', async () => {
		const { authority, reader, state } = fixture()
		const originalIssue = await Effect.runPromise(authority.issue(issue))
		state.responseLost = true
		expect(await result(authority.bind(bind))).toMatchObject({
			_tag: 'Left',
			left: { type: 'EffectAmbiguous' },
		})
		const row = state.coupons().get(bind.couponId)
		if (!row) throw new Error('missing')
		row.usedCount = 1
		row.status = 0
		state.clock = issue.expiresAt
		for (const grant of state.grants().values())
			grant.deletedAt = new Date(state.clock)
		const before = structuredClone({
			coupons: [...state.coupons()],
			grants: [...state.grants()],
			transactions: state.transactions,
		})
		const issueHistory = await Effect.runPromise(reader.inspectIssue(issue))
		const bindHistory = await Effect.runPromise(reader.inspectBinding(bind))
		expect(issueHistory).toMatchObject({
			type: 'Recorded',
			receipt: originalIssue,
		})
		expect(bindHistory).toMatchObject({
			type: 'Recorded',
			receipt: state.committedResults[1],
			current: { couponStatus: 0, usedCount: 1, grantDeletedAt: state.clock },
		})
		expect({
			coupons: [...state.coupons()],
			grants: [...state.grants()],
			transactions: state.transactions,
		}).toEqual(before)
		if (issueHistory.type !== 'Recorded') throw new Error('missing history')
		const issueStimulus = {
			type: 'CouponIssued',
			stimulusId: 'recovered-issue',
			journeyId,
			intentKey: issue.idempotencyKey,
			coupon: issueHistory.receipt.coupon,
		}
		if (
			bindHistory.type !== 'Recorded' ||
			bindHistory.receipt.coupon.binding.type !== 'BoundToVerifiedUser'
		)
			throw new Error('missing binding history')
		const boundStimulus = {
			type: 'CouponBoundToUser',
			stimulusId: 'recovered-binding',
			journeyId,
			intentKey: bind.idempotencyKey,
			couponId: bindHistory.receipt.coupon.couponId,
			verifiedUserId: bindHistory.receipt.coupon.binding.verifiedUserId,
			boundAt: bindHistory.receipt.coupon.binding.boundAt,
		}
		for (const stimulus of [issueStimulus, boundStimulus]) {
			const decoded = validatePersistedCommitEvidenceEnvelope(
				{
					format: EVERGREEN_OFFER_JOURNEY_COMMIT_EVIDENCE_FORMAT,
					expectedVersion: 1,
					stimulus,
					currentFacts: {
						contactId: issue.contactId,
						purchase: null,
						delivery: { type: 'Eligible' },
						existingJourneyId: journeyId,
						automationControl: { type: 'Enabled', version: 'fixture' },
						evidenceVersion: 'fixture',
						readAt: issue.expiresAt,
					},
					definition: EVERGREEN_OFFER_JOURNEY_V1,
					decidedAt: issue.expiresAt,
				},
				{
					stimulusId: stimulus.stimulusId,
					stimulusType: stimulus.type,
					journeyId,
					actorVersion: 2,
					decidedAt: issue.expiresAt,
				},
			)
			if (!decoded.ok) throw new Error(JSON.stringify(decoded.error))
			expect(decoded.value.stimulus).toEqual(stimulus)
		}
		const gate = await authorizeExclusiveCouponSelection({
			adapter: {
				getCoupon: async () => row,
				getMerchantCoupon: async () => state.merchant,
				getEntitlementTypeByName: async () => ({ id: 'credit-type-fixture' }),
				getEntitlementsForUser: async () => [...state.grants().values()],
			},
			verifiedUserId,
			quantity: 1,
			productId: issue.terms.productId,
			requestedSiteCouponId: bind.couponId,
			requestedMerchantCouponId: evidence.id,
			now: new Date(state.clock),
		})
		expect(gate.authorized).toBe(false)
		expect(await result(authority.issue(issue))).toMatchObject(permanent)
		expect(await result(authority.bind(bind))).toMatchObject(permanent)
	})
	it.each([
		'missing-grant',
		'wrong-grant-owner',
		'wrong-coupon-owner',
		'malformed-observation',
	])('reports Unknown for %s', async (scenario) => {
		const { authority, reader, state } = fixture()
		await Effect.runPromise(authority.issue(issue))
		await Effect.runPromise(authority.bind(bind))
		if (scenario === 'missing-grant') state.grants().clear()
		if (scenario === 'wrong-grant-owner')
			for (const grant of state.grants().values()) grant.userId = 'wrong'
		const row = state.coupons().get(bind.couponId)
		if (!row) throw new Error('missing')
		if (scenario === 'wrong-coupon-owner')
			row.fields = {
				exclusive: true,
				evergreenOffer: {
					format: 1,
					issue: { ...issue, contactId: 'wrong' },
					binding: { type: 'AwaitingVerifiedUser' },
				},
			}
		if (scenario === 'malformed-observation')
			row.fields = {
				exclusive: true,
				evergreenOffer: {
					format: 1,
					issue,
					operationObservedAt: 'bad',
					binding: { type: 'AwaitingVerifiedUser' },
				},
			}
		expect(await Effect.runPromise(reader.inspectBinding(bind))).toMatchObject({
			type: 'Unknown',
		})
	})
	it('labels missing legacy observation Unknown, never backfills it, and replay retains new observation', async () => {
		const { authority, reader, state } = fixture()
		await Effect.runPromise(authority.issue(issue))
		state.clock = '2026-09-11T00:00:00.000Z'
		await Effect.runPromise(authority.issue(issue))
		expect(await Effect.runPromise(reader.inspectIssue(issue))).toMatchObject({
			type: 'Recorded',
			operationObservedAt: { type: 'Known', at: '2026-09-10T17:00:00.000Z' },
		})
		const row = state.coupons().get(bind.couponId)
		if (!row) throw new Error('missing')
		row.fields = {
			exclusive: true,
			evergreenOffer: {
				format: 1,
				issue,
				binding: { type: 'AwaitingVerifiedUser' },
			},
		}
		expect(await Effect.runPromise(reader.inspectIssue(issue))).toMatchObject({
			type: 'Recorded',
			operationObservedAt: { type: 'Unknown' },
		})
		expect(row.createdAt.toISOString()).toBe(issue.issueAt)
		await Effect.runPromise(authority.bind(bind))
		expect(await Effect.runPromise(reader.inspectBinding(bind))).toMatchObject({
			type: 'Recorded',
			operationObservedAt: { type: 'Unknown' },
		})
	})
	it('refuses a new INSERT readback that loses the operation observation', async () => {
		const { options, state } = fixture()
		const faulty: CouponCommerceStore = {
			withContactLock: (id, work) =>
				options.store.withContactLock(id, (tx) =>
					work({
						...tx,
						insertCoupon: (row) =>
							tx.insertCoupon({
								...row,
								fields: {
									exclusive: true,
									evergreenOffer: {
										format: 1,
										issue,
										binding: { type: 'AwaitingVerifiedUser' },
									},
								},
							}),
					}),
				),
		}
		expect(
			await result(
				createCouponAuthority({ ...options, store: faulty }).issue(issue),
			),
		).toMatchObject({
			_tag: 'Left',
			left: {
				type: 'EffectPermanentRefusal',
				reason: 'coupon-observation-readback-conflict',
			},
		})
		expect(state.coupons().size).toBe(0)
	})
})

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
		Object.assign(state.merchant, {
			[field]: field === 'status' ? 0 : 'wrong',
		})
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
