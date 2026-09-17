import { Effect } from 'effect'

import type {
	ClaimApplication,
	ClaimStatus,
} from '@/server/evergreen-claim-http'
import type { AuthenticatedOAuthLinkSession } from '@/server/oauth-link-session'

import { evergreenJourneyIdForContact } from './drovr-evergreen-coupon'
import {
	readCouponEvidence,
	semanticCouponId,
	type CommerceCouponRow,
	type VerifiedCouponOwnerQuery,
} from './evergreen-offer-journey/coupon-authority'
import type { CouponAuthority } from './evergreen-offer-journey/ports'
import {
	couponBindingIntentKey,
	couponIntentKey,
	parseContactId,
	parseCouponId,
	parseVerifiedUserId,
} from './evergreen-offer-journey/primitives'

/**
 * The claim for a drovr-issued evergreen coupon. The URL carries nothing of
 * authority: the logged-in session's user resolves to the owning contact by
 * verified email, the contact resolves to its one coupon by semantic id, and
 * the authority binds that coupon to the user (an `apply_special_credit`
 * entitlement) so checkout and pricing pick it up. The coupon row stays the
 * expiry authority; binding never extends the window.
 */

export type DrovrClaimReaders = {
	userById: (
		id: string,
	) => Promise<
		{ id: string; email: string | null; emailVerified: Date | null } | undefined
	>
	contactsByEmail: (
		email: string,
	) => Promise<{ id: string; email: string | null }[]>
	couponById: (id: string) => Promise<CommerceCouponRow | undefined>
}

export type DrovrClaimResolution =
	| { status: 'unavailable'; reason: string }
	| { status: 'verification-needed'; userId: string }
	| {
			status: 'ready' | 'bound'
			userId: string
			contactId: string
			couponId: string
			journeyId: ReturnType<typeof evergreenJourneyIdForContact>
	  }

const lower = (value: string | null | undefined) =>
	(value ?? '').trim().toLowerCase()

export async function resolveDrovrClaim(input: {
	readers: DrovrClaimReaders
	session: AuthenticatedOAuthLinkSession
	now: () => string
}): Promise<DrovrClaimResolution> {
	const user = await input.readers.userById(input.session.userId)
	if (!user?.email) return { status: 'unavailable', reason: 'user-missing' }
	const owners = await input.readers.contactsByEmail(user.email)
	const owner = owners.find((row) => lower(row.email) === lower(user.email))
	if (!owner || owners.length !== 1) {
		return { status: 'unavailable', reason: 'contact-not-resolved' }
	}
	const journeyId = evergreenJourneyIdForContact(owner.id)
	const couponId = semanticCouponId(couponIntentKey(journeyId))
	const row = await input.readers.couponById(couponId)
	if (!row) return { status: 'unavailable', reason: 'coupon-not-issued' }
	let evidence: ReturnType<typeof readCouponEvidence>
	try {
		evidence = readCouponEvidence(row)
	} catch {
		return { status: 'unavailable', reason: 'coupon-not-readable' }
	}
	if (row.status !== 1 || row.usedCount !== 0) {
		return { status: 'unavailable', reason: 'coupon-spent-or-inactive' }
	}
	const clock = Date.parse(input.now())
	if (
		clock < Date.parse(evidence.coupon.issuedAt) ||
		clock >= Date.parse(evidence.coupon.expiresAt)
	) {
		return { status: 'unavailable', reason: 'outside-coupon-window' }
	}
	if (evidence.coupon.contactId !== owner.id) {
		return { status: 'unavailable', reason: 'coupon-owner-mismatch' }
	}
	const bound =
		evidence.coupon.binding.type === 'BoundToVerifiedUser'
			? evidence.coupon.binding.verifiedUserId
			: undefined
	if (bound !== undefined && bound !== user.id) {
		return { status: 'unavailable', reason: 'bound-to-another-user' }
	}
	const base = { userId: user.id, contactId: owner.id, couponId, journeyId }
	if (bound === user.id) return { status: 'bound', ...base }
	if (!user.emailVerified) {
		return { status: 'verification-needed', userId: user.id }
	}
	return { status: 'ready', ...base }
}

/**
 * The authority's owner proof for a claim: the locked user and the locked
 * contact share the same verified email. Anything else is not proof and the
 * bind refuses.
 */
export function drovrClaimVerifiedOwnerReader(now: () => string) {
	return async (query: VerifiedCouponOwnerQuery) => {
		if (
			!query.lockedUser.emailVerified ||
			lower(query.lockedUser.email) !== lower(query.lockedContact.email)
		) {
			return null
		}
		return {
			type: 'VerifiedUserObserved',
			contactId: query.contactId,
			journeyId: query.journeyId,
			verifiedUserId: query.verifiedUserId,
			observedAt: now(),
			sourceReference: `drovr-claim:user:${query.verifiedUserId}`,
		}
	}
}

export function createDrovrEvergreenClaimApplication(options: {
	readers: DrovrClaimReaders
	authority: Pick<CouponAuthority, 'bind'>
	now: () => string
	onBindFailure?: (reason: string) => void
}): ClaimApplication {
	const resolve = (session: AuthenticatedOAuthLinkSession) =>
		resolveDrovrClaim({ readers: options.readers, session, now: options.now })
	const statusOf = (resolution: DrovrClaimResolution): ClaimStatus =>
		resolution.status
	return {
		async status(session) {
			return statusOf(await resolve(session))
		},
		async claim(session) {
			const resolution = await resolve(session)
			if (resolution.status !== 'ready') return statusOf(resolution)
			const contactId = parseContactId(resolution.contactId)
			const couponId = parseCouponId(resolution.couponId)
			const verifiedUserId = parseVerifiedUserId(resolution.userId)
			if (!contactId.ok || !couponId.ok || !verifiedUserId.ok) {
				return 'unavailable'
			}
			const outcome = await Effect.runPromise(
				Effect.either(
					options.authority.bind({
						type: 'BindCoupon',
						idempotencyKey: couponBindingIntentKey({
							journeyId: resolution.journeyId,
							verifiedUserId: verifiedUserId.value,
						}),
						journeyId: resolution.journeyId,
						couponId: couponId.value,
						contactId: contactId.value,
						verifiedUserId: verifiedUserId.value,
					}),
				),
			)
			if (outcome._tag === 'Left') {
				options.onBindFailure?.(`${outcome.left.type}:${outcome.left.reason}`)
				return outcome.left.type === 'EffectTransientUnavailable'
					? 'pending'
					: 'unavailable'
			}
			return 'bound'
		},
	}
}
