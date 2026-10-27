import { resolveServerComputedCheckoutCoupon } from '@/coursebuilder/server-computed-checkout-coupon'
import { hashCheckoutLoginBrowserSession } from '@/lib/checkout-login-browser-session'
import {
	hashCheckoutLoginHandoffNonce,
	type CheckoutLoginHandoffVerification,
	verifyCheckoutLoginHandoff,
} from '@/lib/checkout-login-handoff'
import type {
	CheckoutLoginHandoffClaim,
	CheckoutLoginHandoffStore,
} from '@/lib/checkout-login-handoff-store'
import {
	authorizeExclusiveCouponSelection,
	type ExclusiveCouponAuthorizationDecision,
} from '@/lib/exclusive-coupon-authorization'

import type { CommerceAdapter } from '@coursebuilder/commerce'
import { AUTHORITATIVE_PPP_OFFER_ID } from '@coursebuilder/commerce/authoritative-price'

export type LoggedInCheckoutPricingResult =
	| {
			kind: 'ready'
			country: string
			couponId?: string
			usedCouponId?: string
			claim?: CheckoutLoginHandoffClaim
			checkoutHandoff: CheckoutLoginHandoffVerification
			couponAuthorization: ExclusiveCouponAuthorizationDecision
	  }
	| {
			kind: 'completed'
			providerSessionId: string
			redirect: string
	  }
	| { kind: 'rejected'; reason: string }

export async function resolveLoggedInCheckoutPricing({
	adapter,
	handoffStore,
	verifiedUserId,
	checkoutParams,
	checkoutHandoffToken,
	browserSession,
	trustedCountry,
	handoffSecret,
	authoritativeProductIds,
	now = new Date(),
}: {
	adapter: CommerceAdapter
	handoffStore: CheckoutLoginHandoffStore
	verifiedUserId: string
	checkoutParams: {
		productId: string
		quantity?: number
		country?: string
		couponId?: string
		usedCouponId?: string
	}
	checkoutHandoffToken?: string
	browserSession?: string
	trustedCountry: string
	handoffSecret?: string
	/** Products priced by the app's authoritative-price hook. */
	authoritativeProductIds?: ReadonlySet<string>
	now?: Date
}): Promise<LoggedInCheckoutPricingResult> {
	const quantity = checkoutParams.quantity ?? 1
	const couponAuthorization = await authorizeExclusiveCouponSelection({
		adapter,
		verifiedUserId,
		productId: checkoutParams.productId,
		quantity,
		requestedMerchantCouponId: checkoutParams.couponId,
		requestedSiteCouponId: checkoutParams.usedCouponId,
		now,
	})
	const checkoutHandoff = verifyCheckoutLoginHandoff({
		token: checkoutHandoffToken,
		secret: handoffSecret,
		expected: {
			country: checkoutParams.country ?? '',
			productId: checkoutParams.productId,
			quantity,
		},
		now,
	})

	let claim: CheckoutLoginHandoffClaim | undefined
	if (checkoutHandoffToken) {
		if (!checkoutHandoff.valid) {
			return {
				kind: 'rejected',
				reason: `invalid-${checkoutHandoff.reason}`,
			}
		}
		if (!browserSession) {
			return { kind: 'rejected', reason: 'browser-mismatch' }
		}

		const claimResult = await handoffStore.claim({
			nonceHash: hashCheckoutLoginHandoffNonce(
				checkoutHandoff.payload.nonce,
			),
			browserSessionHash: hashCheckoutLoginBrowserSession(browserSession),
			payload: checkoutHandoff.payload,
			userId: verifiedUserId,
			now,
		})
		if (claimResult.kind === 'completed') {
			return {
				kind: 'completed',
				providerSessionId: claimResult.receipt.providerSessionId,
				redirect: claimResult.receipt.redirect,
			}
		}
		if (claimResult.kind !== 'acquired') {
			return {
				kind: 'rejected',
				reason:
					claimResult.kind === 'replayed'
						? `replayed-${claimResult.state}`
						: claimResult.kind,
			}
		}
		claim = claimResult.claim
	}

	// The hook prices these from the trusted country. The PPP offer id is only
	// the buyer's consent; the hook checks eligibility itself. No coupon
	// selector or server-computed coupon reaches checkout.
	if (authoritativeProductIds?.has(checkoutParams.productId)) {
		return {
			kind: 'ready',
			country:
				checkoutHandoff.valid && claim
					? checkoutHandoff.payload.country
					: trustedCountry,
			couponId:
				checkoutParams.couponId === AUTHORITATIVE_PPP_OFFER_ID
					? AUTHORITATIVE_PPP_OFFER_ID
					: undefined,
			usedCouponId: undefined,
			claim,
			checkoutHandoff,
			couponAuthorization,
		}
	}

	// PPP intent permits recomputation. It does not prove country. The country is
	// usable only after signature verification and an atomic durable claim.
	const validPppHandoff =
		couponAuthorization.requestedPPP === true &&
		checkoutHandoff.valid &&
		checkoutHandoff.payload.pppSelected &&
		Boolean(claim)
	const country = validPppHandoff
		? checkoutHandoff.payload.country
		: trustedCountry
	const serverComputedCoupon = !couponAuthorization.authorized
		? await resolveServerComputedCheckoutCoupon({
				adapter,
				productId: checkoutParams.productId,
				quantity,
				verifiedUserId,
				country,
			})
		: null

	return {
		kind: 'ready',
		country,
		couponId: couponAuthorization.authorized
			? checkoutParams.couponId
			: serverComputedCoupon?.id,
		usedCouponId: couponAuthorization.authorized
			? (couponAuthorization.entitlementCouponId ?? checkoutParams.usedCouponId)
			: undefined,
		claim,
		checkoutHandoff,
		couponAuthorization,
	}
}
