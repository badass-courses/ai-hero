import { protectCourseBuilderRequest } from '@/coursebuilder/coursebuilder-request-authorization'
import { purchaseBlockedCheckoutRefusal } from '@/coursebuilder/purchase-block-checkout'
import { resolveServerComputedCheckoutCoupon } from '@/coursebuilder/server-computed-checkout-coupon'
import { syntheticCheckoutRefusal } from '@/coursebuilder/synthetic-checkout'
import { courseBuilderAdapter } from '@/db'
import { AUTHORITATIVE_PRODUCT_IDS } from '@/lib/c5-pricing/decision'
import { REGIONAL_UPGRADE_PATH } from '@/lib/c5-pricing/products'
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
	// No upgrade path: a buyer who holds a region-restricted ticket goes to
	// support, which upgrades it, instead of a checkout error.
	if (
		userId &&
		authoritativeProduct &&
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

