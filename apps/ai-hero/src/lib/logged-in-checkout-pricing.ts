import { resolveServerComputedCheckoutCoupon } from '@/coursebuilder/server-computed-checkout-coupon'
import { verifyCheckoutLoginHandoff } from '@/lib/checkout-login-handoff'
import { authorizeExclusiveCouponSelection } from '@/lib/exclusive-coupon-authorization'

import type { CourseBuilderAdapter } from '@coursebuilder/core/adapters'

export async function resolveLoggedInCheckoutPricing({
	adapter,
	verifiedUserId,
	checkoutParams,
	checkoutHandoffToken,
	trustedCountry,
	handoffSecret,
	now,
}: {
	adapter: CourseBuilderAdapter
	verifiedUserId: string
	checkoutParams: {
		productId: string
		quantity?: number
		country?: string
		couponId?: string
		usedCouponId?: string
	}
	checkoutHandoffToken?: string
	trustedCountry: string
	handoffSecret?: string
	now?: Date
}) {
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
	// PPP intent permits recomputation. It does not prove country. Only the
	// signature binds country to the pre-login product and quantity.
	const validPppHandoff =
		couponAuthorization.requestedPPP === true &&
		checkoutHandoff.valid &&
		checkoutHandoff.payload.pppSelected
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
		country,
		couponId: couponAuthorization.authorized
			? checkoutParams.couponId
			: serverComputedCoupon?.id,
		usedCouponId: couponAuthorization.authorized
			? (couponAuthorization.entitlementCouponId ?? checkoutParams.usedCouponId)
			: undefined,
		checkoutHandoff,
		couponAuthorization,
	}
}
