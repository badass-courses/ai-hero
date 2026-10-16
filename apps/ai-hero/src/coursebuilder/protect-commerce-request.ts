import { protectCourseBuilderRequest } from '@/coursebuilder/coursebuilder-request-authorization'
import { purchaseBlockedCheckoutRefusal } from '@/coursebuilder/purchase-block-checkout'
import { resolveServerComputedCheckoutCoupon } from '@/coursebuilder/server-computed-checkout-coupon'
import { syntheticCheckoutRefusal } from '@/coursebuilder/synthetic-checkout'
import { courseBuilderAdapter } from '@/db'
import { AUTHORITATIVE_PRODUCT_IDS } from '@/lib/c5-pricing/decision'
import { AUTHORITATIVE_PPP_OFFER_ID } from '@coursebuilder/commerce/authoritative-price'
import { REGIONAL_UPGRADE_PATH } from '@/lib/c5-pricing/products'
import {
	duplicatePurchaseGuard,
	REGIONAL_TEAM_NOT_ALLOWED_PATH,
} from '@/lib/purchase-guardrails'
import { holdsRestrictedPurchase } from '@/lib/c5-pricing/restricted-holder'
import { getServerAuthSession } from '@/server/auth'
import type { NextRequest } from 'next/server'

export const isProtectedCommerceRequest = (request: NextRequest) =>
	request.nextUrl.pathname.endsWith('/prices-formatted') ||
	request.nextUrl.pathname.includes('/checkout/')

const isCheckoutRequest = (request: NextRequest) =>
	request.nextUrl.pathname.includes('/checkout/')

/** The authoritative product a checkout request is for, if any. */
export const authoritativeCheckoutProduct = (request: NextRequest) => {
	if (!isCheckoutRequest(request)) return null
	const productId = request.nextUrl.searchParams.get('productId')
	return productId && AUTHORITATIVE_PRODUCT_IDS.has(productId) ? productId : null
}

/**
 * Authorization runs before any pricing: synthetic principals and buyers who
 * lost a chargeback are refused here, so the authoritative-price hook never
 * sees their checkout.
 */
export const protectCommerceRequest = async (
	request: NextRequest,
	deps: {
		session?: () => Promise<{ userId?: string }>
		isBlocked?: (userId: string) => Promise<boolean>
		holdsRestricted?: (userId: string, productId: string) => Promise<boolean>
	} = {},
): Promise<{ request: NextRequest | Response; userId?: string }> => {
	if (!isProtectedCommerceRequest(request)) return { request }

	const userId = deps.session
		? (await deps.session()).userId
		: (await getServerAuthSession()).session?.user?.id
	const refusal = syntheticCheckoutRefusal(request.nextUrl.pathname, userId)
	if (refusal) return { request: refusal, userId }
	const blocked = await purchaseBlockedCheckoutRefusal(
		request.url,
		request.nextUrl.pathname,
		userId,
		deps.isBlocked,
	)
	if (blocked) return { request: blocked, userId }
	const guarded = await protectCourseBuilderRequest(request, {
		adapter: courseBuilderAdapter,
		verifiedUserId: userId,
		authoritativeProductIds: AUTHORITATIVE_PRODUCT_IDS,
		resolveServerComputedMerchantCoupon: (input) =>
			resolveServerComputedCheckoutCoupon({
				...input,
				adapter: courseBuilderAdapter,
			}),
	})
	const authoritativeProduct = authoritativeCheckoutProduct(guarded)
	const quantity = Number(guarded.nextUrl.searchParams.get('quantity') ?? 1)
	// Same decision as checkout: a Restricted holder is an existing seat holder.
	const restrictedHolderDecision = duplicatePurchaseGuard({
		productType: 'cohort',
		quantity,
		existing: [{ status: 'Restricted', bulk: false }],
		regionalCouponApplied: false,
	})
	// Regional pricing is single-seat only: refuse, never silently drop it.
	if (
		isCheckoutRequest(request) &&
		duplicatePurchaseGuard({
			productType: 'cohort',
			quantity,
			existing: [],
			regionalCouponApplied:
				request.nextUrl.searchParams.get('couponId') ===
				AUTHORITATIVE_PPP_OFFER_ID,
		}) === 'regional-team-not-allowed'
	) {
		return {
			request: Response.redirect(
				new URL(REGIONAL_TEAM_NOT_ALLOWED_PATH, request.url),
				303,
			),
			userId,
		}
	}
	// No upgrade path: a single-seat buyer who holds a region-restricted ticket
	// goes to support, which upgrades it. Team orders pass.
	if (
		userId &&
		authoritativeProduct &&
		restrictedHolderDecision === 'already-own' &&
		(await (deps.holdsRestricted ?? holdsRestrictedPurchase)(
			userId,
			authoritativeProduct,
		))
	) {
		return {
			request: Response.redirect(
				new URL(REGIONAL_UPGRADE_PATH, request.url),
				303,
			),
			userId,
		}
	}
	// An authoritative product is priced from the signed-in buyer's facts.
	// Nobody signed in goes to sign-in first; no Stripe session is created
	// for an anonymous upper-bound price.
	if (!userId && authoritativeProduct) {
		return {
			request: Response.redirect(
				new URL(
					`/subscribe/verify-login?${guarded.nextUrl.searchParams.toString()}`,
					request.url,
				),
				303,
			),
		}
	}
	return { request: guarded, userId }
}

