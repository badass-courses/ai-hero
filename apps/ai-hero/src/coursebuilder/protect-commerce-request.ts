import { protectCourseBuilderRequest } from '@/coursebuilder/coursebuilder-request-authorization'
import { purchaseBlockedCheckoutRefusal } from '@/coursebuilder/purchase-block-checkout'
import { resolveServerComputedCheckoutCoupon } from '@/coursebuilder/server-computed-checkout-coupon'
import { syntheticCheckoutRefusal } from '@/coursebuilder/synthetic-checkout'
import { courseBuilderAdapter, db } from '@/db'
import { purchases } from '@/db/schema'
import { AUTHORITATIVE_PRODUCT_IDS } from '@/lib/c5-pricing/decision'
import { REGIONAL_UPGRADE_PATH } from '@/lib/c5-pricing/products'
import { getProduct } from '@/lib/products-query'
import {
	ALREADY_OWN_PATH,
	duplicatePurchaseGuard,
	INVALID_QUANTITY_PATH,
	isRegionalCoupon,
	parseCheckoutQuantity,
	REGIONAL_TEAM_NOT_ALLOWED_PATH,
} from '@/lib/purchase-guardrails'
import { getServerAuthSession } from '@/server/auth'
import { and, eq, inArray } from 'drizzle-orm'
import type { NextRequest } from 'next/server'

import { AUTHORITATIVE_PPP_OFFER_ID } from '@coursebuilder/commerce/authoritative-price'

export const isProtectedCommerceRequest = (request: NextRequest) =>
	request.nextUrl.pathname.endsWith('/prices-formatted') ||
	request.nextUrl.pathname.includes('/checkout/')

const isCheckoutRequest = (request: NextRequest) =>
	request.nextUrl.pathname.includes('/checkout/')

/** The authoritative product a checkout request is for, if any. */
export const authoritativeCheckoutProduct = (request: NextRequest) => {
	if (!isCheckoutRequest(request)) return null
	const productId = request.nextUrl.searchParams.get('productId')
	return productId && AUTHORITATIVE_PRODUCT_IDS.has(productId)
		? productId
		: null
}

type ExistingPurchase = { status: string; bulk: boolean }

const loadExistingPurchases = async (
	userId: string,
	productId: string,
): Promise<ExistingPurchase[]> => {
	const rows = await db.query.purchases.findMany({
		where: and(
			eq(purchases.userId, userId),
			eq(purchases.productId, productId),
			inArray(purchases.status, ['Valid', 'Restricted']),
		),
	})
	return rows.map((row) => ({
		status: row.status,
		bulk: Boolean(row.bulkCouponId),
	}))
}

/**
 * The stored type of the coupon on the final request. The authoritative offer
 * is not a stored coupon; a coupon the server just computed carries its type;
 * any other coupon the protector kept (a client-sent one) is looked up, so a
 * kept PPP merchant coupon cannot ride on a team order.
 */
const finalCouponType = async (
	couponId: string | null,
	serverComputed: { id: string; type?: string | null } | null | undefined,
	lookup?: (couponId: string) => Promise<string | null | undefined>,
) => {
	if (!couponId || couponId === AUTHORITATIVE_PPP_OFFER_ID) return null
	if (serverComputed?.id === couponId) return serverComputed.type
	return (
		await (lookup ??
			(async (id: string) =>
				(await courseBuilderAdapter.getMerchantCoupon(id))?.type))(couponId)
	)
}

const loadProductType = async (productId: string) =>
	(await getProduct(productId))?.type

/**
 * Authorization runs before any pricing: synthetic principals and buyers who
 * lost a chargeback are refused here, so the authoritative-price hook never
 * sees their checkout.
 *
 * The duplicate-purchase and regional-team decision is made here once, on the
 * final request (after coupon authorization and the server-computed coupon),
 * from the buyer's real purchases. verify-login is only a convenience hop; its
 * approval is not bound to this POST, so this is the gate.
 */
export const protectCommerceRequest = async (
	request: NextRequest,
	deps: {
		session?: () => Promise<{ userId?: string }>
		isBlocked?: (userId: string) => Promise<boolean>
		existingPurchases?: (
			userId: string,
			productId: string,
		) => Promise<ExistingPurchase[]>
		productType?: (productId: string) => Promise<string | null | undefined>
		couponType?: (couponId: string) => Promise<string | null | undefined>
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
	const serverComputed: {
		coupon?: { id: string; type?: string | null } | null
	} = {}
	const guarded = await protectCourseBuilderRequest(request, {
		adapter: courseBuilderAdapter,
		verifiedUserId: userId,
		authoritativeProductIds: AUTHORITATIVE_PRODUCT_IDS,
		resolveServerComputedMerchantCoupon: async (input) => {
			serverComputed.coupon = await resolveServerComputedCheckoutCoupon({
				...input,
				adapter: courseBuilderAdapter,
			})
			return serverComputed.coupon
		},
	})
	const authoritativeProduct = authoritativeCheckoutProduct(guarded)
	const redirectTo = (path: string) => ({
		request: Response.redirect(new URL(path, request.url), 303),
		userId,
	})
	if (isCheckoutRequest(request)) {
		// Course Builder builds `request.query` with `Object.fromEntries` over
		// the URL, so the last value of a repeated key wins. Read the same way.
		const params = guarded.nextUrl.searchParams
		const param = (key: string) => params.getAll(key).at(-1) ?? null
		const productId = param('productId')
		// The buy form POSTs to a URL that carries quantity in the query
		// (`buildStripeCheckoutPath` in pricing.tsx); the body is empty.
		const quantity = parseCheckoutQuantity(param('quantity'))
		if (quantity === null) return redirectTo(INVALID_QUANTITY_PATH)
		if (productId) {
			// The coupon on the final request, not the raw one: authorization
			// may have dropped it, and the server may have attached its own.
			const couponId = param('couponId')
			const regionalCouponApplied =
				quantity >= 2 &&
				isRegionalCoupon({
					couponId,
					couponType: await finalCouponType(
						couponId,
						serverComputed.coupon,
						deps.couponType,
					),
				})
			// A team order skips the duplicate guard, so it needs neither the
			// product type nor the buyer's purchases.
			const single = quantity < 2
			const existing =
				single && userId
					? await (deps.existingPurchases ?? loadExistingPurchases)(
							userId,
							productId,
						)
					: []
			const decision = duplicatePurchaseGuard({
				productType: single
					? await (deps.productType ?? loadProductType)(productId)
					: undefined,
				quantity,
				existing,
				regionalCouponApplied,
			})
			if (decision === 'regional-team-not-allowed')
				return redirectTo(REGIONAL_TEAM_NOT_ALLOWED_PATH)
			if (decision === 'already-own') {
				// No upgrade path: a regional holder reaches unrestricted access
				// through support instead of a checkout error.
				return redirectTo(
					authoritativeProduct &&
						existing.some((purchase) => purchase.status === 'Restricted')
						? REGIONAL_UPGRADE_PATH
						: ALREADY_OWN_PATH,
				)
			}
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
