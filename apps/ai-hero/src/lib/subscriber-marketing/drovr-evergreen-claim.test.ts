import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
	createDrovrEvergreenClaimApplication,
	drovrClaimVerifiedOwnerReader,
	resolveDrovrClaim,
	type DrovrClaimReaders,
} from './drovr-evergreen-claim'
import { evergreenJourneyIdForContact } from './drovr-evergreen-coupon'
import {
	semanticCouponId,
	type CommerceCouponRow,
} from './evergreen-offer-journey/coupon-authority'
import { couponIntentKey } from './evergreen-offer-journey/primitives'

const now = () => '2026-09-11T16:00:00.000Z'
const journeyId = evergreenJourneyIdForContact('contact-1')
const couponId = semanticCouponId(couponIntentKey(journeyId))
const issue = {
	type: 'IssueCoupon',
	idempotencyKey: couponIntentKey(journeyId),
	journeyId,
	contactId: 'contact-1',
	issueAt: '2026-09-10T16:00:00.000Z',
	expiresAt: '2026-09-15T06:59:59.000Z',
	terms: {
		productId: 'product-ma254',
		currency: 'USD',
		amountOffCents: 10_000,
		maxUses: 1,
		exclusive: true,
	},
	deadlineTimeZone: {
		type: 'BrowserEntryHeader',
		headerName: 'x-vercel-ip-timezone',
		timeZone: 'America/Los_Angeles',
		capturedAt: '2026-09-10T16:00:00.000Z',
	},
}
const couponRow = (
	binding: Record<string, unknown> = { type: 'AwaitingVerifiedUser' },
	overrides: Partial<CommerceCouponRow> = {},
): CommerceCouponRow =>
	({
		id: couponId,
		organizationId: null,
		code: null,
		createdAt: new Date(issue.issueAt),
		expires: new Date(issue.expiresAt),
		fields: { exclusive: true, evergreenOffer: { format: 1, issue, binding } },
		maxUses: 1,
		default: false,
		merchantCouponId: 'ai_merchant',
		status: 1,
		usedCount: 0,
		percentageDiscount: null,
		amountDiscount: 10_000,
		restrictedToProductId: 'product-ma254',
		...overrides,
	}) as CommerceCouponRow

const readers = (input: {
	user?: { id: string; email: string | null; emailVerified: Date | null }
	contacts?: { id: string; email: string | null }[]
	coupon?: CommerceCouponRow
}): DrovrClaimReaders => ({
	userById: async () => input.user,
	contactByEmail: async (email) =>
		(input.contacts ?? []).find(
			(c) =>
				(c.email ?? '').trim().toLowerCase() === email.trim().toLowerCase(),
		),
	couponById: async (id) => (id === couponId ? input.coupon : undefined),
})
const verified = {
	id: 'user-1',
	email: 'Learner@Example.com',
	emailVerified: new Date('2026-09-01T00:00:00.000Z'),
}
const session = { userId: 'user-1', sessionToken: 'tok' }

describe('resolveDrovrClaim', () => {
	it('is ready when the verified user owns the contact and the coupon is in window', async () => {
		const result = await resolveDrovrClaim({
			readers: readers({
				user: verified,
				contacts: [{ id: 'contact-1', email: 'learner@example.com' }],
				coupon: couponRow(),
			}),
			session,
			now,
		})
		expect(result).toEqual({
			status: 'ready',
			userId: 'user-1',
			contactId: 'contact-1',
			couponId,
			journeyId,
		})
	})

	it('needs verification when the user email is unverified', async () => {
		const result = await resolveDrovrClaim({
			readers: readers({
				user: { ...verified, emailVerified: null },
				contacts: [{ id: 'contact-1', email: 'learner@example.com' }],
				coupon: couponRow(),
			}),
			session,
			now,
		})
		expect(result).toEqual({ status: 'verification-needed', userId: 'user-1' })
	})

	it('reports bound for the same user and unavailable for a different one', async () => {
		const bound = {
			type: 'BoundToVerifiedUser',
			verifiedUserId: 'user-1',
			boundAt: '2026-09-11T15:00:00.000Z',
			intentKey: `${journeyId}:coupon.bind:user-1`,
			entitlementId: 'eoj-credit:x',
			sourceReference: 'drovr-claim:user:user-1',
		}
		const mine = await resolveDrovrClaim({
			readers: readers({
				user: verified,
				contacts: [{ id: 'contact-1', email: 'learner@example.com' }],
				coupon: couponRow(bound),
			}),
			session,
			now,
		})
		expect(mine.status).toBe('bound')
		const theirs = await resolveDrovrClaim({
			readers: readers({
				user: { ...verified, id: 'user-2' },
				contacts: [{ id: 'contact-1', email: 'learner@example.com' }],
				coupon: couponRow(bound),
			}),
			session: { userId: 'user-2', sessionToken: 'tok' },
			now,
		})
		expect(theirs).toEqual({
			status: 'unavailable',
			reason: 'bound-to-another-user',
		})
	})

	it('is unavailable without a contact, without a coupon, outside the window, or when spent', async () => {
		const contacts = [{ id: 'contact-1', email: 'learner@example.com' }]
		const cases: [DrovrClaimReaders, string, () => string][] = [
			[
				readers({ user: verified, contacts: [], coupon: couponRow() }),
				'contact-not-resolved',
				now,
			],
			[readers({ user: verified, contacts }), 'coupon-not-issued', now],
			[
				readers({ user: verified, contacts, coupon: couponRow() }),
				'outside-coupon-window',
				() => '2026-09-16T00:00:00.000Z',
			],
			[
				readers({
					user: verified,
					contacts,
					coupon: couponRow(undefined, { usedCount: 1 }),
				}),
				'coupon-spent-or-inactive',
				now,
			],
		]
		for (const [r, reason, clock] of cases) {
			expect(
				await resolveDrovrClaim({ readers: r, session, now: clock }),
			).toEqual({
				status: 'unavailable',
				reason,
			})
		}
	})
})

describe('claim application', () => {
	const ready = readers({
		user: verified,
		contacts: [{ id: 'contact-1', email: 'learner@example.com' }],
		coupon: couponRow(),
	})

	it('binds a ready claim through the authority with the binding semantic key', async () => {
		const binds: unknown[] = []
		const app = createDrovrEvergreenClaimApplication({
			readers: ready,
			resolveAuthority: async () => ({
				bind: (intent) => {
					binds.push(intent)
					return Effect.succeed({
						coupon: {} as never,
						providerReceiptId: 'commerce-entitlement:x',
					})
				},
			}),
			now,
		})
		expect(await app.status(session)).toBe('ready')
		expect(await app.claim(session)).toBe('bound')
		expect(binds).toEqual([
			{
				type: 'BindCoupon',
				idempotencyKey: `${journeyId}:coupon.bind:user-1`,
				journeyId,
				couponId,
				contactId: 'contact-1',
				verifiedUserId: 'user-1',
			},
		])
	})

	it('maps authority failures: transient is pending, refusal is unavailable, never a grant', async () => {
		const reasons: string[] = []
		const failing = (failure: {
			type: 'EffectTransientUnavailable' | 'EffectPermanentRefusal'
			reason: string
		}) =>
			createDrovrEvergreenClaimApplication({
				readers: ready,
				resolveAuthority: async () => ({ bind: () => Effect.fail(failure) }),
				now,
				onBindFailure: (reason) => reasons.push(reason),
			})
		expect(
			await failing({ type: 'EffectTransientUnavailable', reason: 'db' }).claim(
				session,
			),
		).toBe('pending')
		expect(
			await failing({
				type: 'EffectPermanentRefusal',
				reason: 'verified-owner-proof-mismatch',
			}).claim(session),
		).toBe('unavailable')
		expect(reasons).toEqual([
			'EffectTransientUnavailable:db',
			'EffectPermanentRefusal:verified-owner-proof-mismatch',
		])
	})

	it('does not bind when the claim is not ready', async () => {
		let binds = 0
		let resolved = 0
		const app = createDrovrEvergreenClaimApplication({
			readers: readers({
				user: { ...verified, emailVerified: null },
				contacts: [{ id: 'contact-1', email: 'learner@example.com' }],
				coupon: couponRow(),
			}),
			resolveAuthority: async () => {
				resolved += 1
				return {
					bind: () => {
						binds += 1
						return Effect.succeed({
							coupon: {} as never,
							providerReceiptId: 'x',
						})
					},
				}
			},
			now,
		})
		expect(await app.status(session)).toBe('verification-needed')
		expect(await app.claim(session)).toBe('verification-needed')
		expect(binds).toBe(0)
		expect(resolved).toBe(0)
	})
})

describe('drovrClaimVerifiedOwnerReader', () => {
	const query = {
		contactId: 'contact-1',
		journeyId,
		verifiedUserId: 'user-1',
		couponId,
		lockedContact: { id: 'contact-1', email: 'learner@example.com' },
		lockedUser: {
			id: 'user-1',
			email: 'Learner@Example.com',
			emailVerified: '2026-09-01T00:00:00.000Z',
		},
	} as never

	it('proves ownership only for a verified user sharing the contact email', async () => {
		const read = drovrClaimVerifiedOwnerReader(now)
		expect(await read(query)).toEqual({
			type: 'VerifiedUserObserved',
			contactId: 'contact-1',
			journeyId,
			verifiedUserId: 'user-1',
			observedAt: now(),
			sourceReference: 'drovr-claim:user:user-1',
		})
		expect(
			await read({
				...(query as object),
				lockedUser: {
					id: 'user-1',
					email: 'other@example.com',
					emailVerified: '2026-09-01T00:00:00.000Z',
				},
			} as never),
		).toBeNull()
		expect(
			await read({
				...(query as object),
				lockedUser: {
					id: 'user-1',
					email: 'learner@example.com',
					emailVerified: null,
				},
			} as never),
		).toBeNull()
	})
})
