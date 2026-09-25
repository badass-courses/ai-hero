import { Effect } from 'effect'

import {
	evergreenOfferUrl,
	issueIntentFor,
	type CouponIssuePayload,
} from '@/lib/subscriber-marketing/drovr-evergreen-coupon'
import type { CouponAuthority } from '@/lib/subscriber-marketing/evergreen-offer-journey/ports'
import {
	EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
	EVERGREEN_OFFER_FALLBACK_TIME_ZONE,
	EVERGREEN_OFFER_MAX_USES,
	EVERGREEN_OFFER_PRODUCT_ID,
} from '@/lib/subscriber-marketing/evergreen-offer-journey/domain'

import {
	TEST_PRINCIPAL_TTL_MS,
	type TestPrincipalIdentity,
} from './test-principal'

export type TestPrincipalCoupon = {
	couponId: string
	offerUrl: string
	expiresAt: string
}

export type TestPrincipalCouponResult =
	| { status: 'issued'; coupon: TestPrincipalCoupon }
	| { status: 'refused'; reason: string }

/**
 * The run's crash-course coupon, issued by the production evergreen coupon
 * authority for the synthetic contact, so the signed-out `?coupon=` link
 * proves real server pricing. Its window is the principal's hour, derived
 * from the principal's createdAt: a repeated mint replays the same issue
 * and gets the same coupon. maxUses stays 1 and nothing reaches Stripe.
 */
export async function issueTestPrincipalCoupon(args: {
	authority: Pick<CouponAuthority, 'issue'>
	identity: TestPrincipalIdentity
	principalCreatedAt: Date
	origin: string
}): Promise<TestPrincipalCouponResult> {
	const issueAt = args.principalCreatedAt
	const expiresAt = new Date(issueAt.getTime() + TEST_PRINCIPAL_TTL_MS)
	const payload: CouponIssuePayload = {
		productId: EVERGREEN_OFFER_PRODUCT_ID,
		amountOffCents: EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
		maxUses: EVERGREEN_OFFER_MAX_USES,
		exclusive: true,
		// Display-only in drovr's pitch fields; the authority prices from terms.
		regularPriceCents: 29_900,
		effectivePriceCents: 29_900 - EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
		issueAt: issueAt.toISOString(),
		expiresAt: expiresAt.toISOString(),
		timezone: EVERGREEN_OFFER_FALLBACK_TIME_ZONE,
		timezoneSource: 'fallback',
	}
	const outcome = await Effect.runPromise(
		Effect.either(
			args.authority.issue(issueIntentFor(args.identity.contactId, payload)),
		),
	)
	if (outcome._tag === 'Left') {
		return {
			status: 'refused',
			reason: `${outcome.left.type}:${outcome.left.reason}`,
		}
	}
	const { coupon } = outcome.right
	return {
		status: 'issued',
		coupon: {
			couponId: coupon.couponId,
			offerUrl: evergreenOfferUrl(args.origin, coupon.couponId),
			expiresAt: coupon.expiresAt,
		},
	}
}
