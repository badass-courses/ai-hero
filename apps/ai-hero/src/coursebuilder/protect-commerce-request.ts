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
	duplicatePurchaseGuard,
	isRegionalCoupon,
	parseCheckoutQuantity,
	REGIONAL_TEAM_NOT_ALLOWED_PATH,
} from '@/lib/purchase-guardrails'
import { getServerAuthSession } from '@/server/auth'
import { and, eq, inArray } from 'drizzle-orm'
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
	return productId && AUTHORITATIVE_PRODUCT_IDS.has(productId)
		? productId
		: null
}

/** Where a refused single-seat duplicate goes, with the reason shown. */
export const ALREADY_OWN_PATH = '/invoices?already-own=1'

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
		const params = guarded.nextUrl.searchParams
		const productId = params.get('productId')
		const quantity = parseCheckoutQuantity(params.get('quantity'))
		if (quantity === null) return redirectTo('/subscribe/error')
		if (productId) {
			// The coupon on the final request, not the raw one: authorization
			// may have dropped it, and the server may have attached its own.
			const couponId = params.get('couponId')
			const regionalCouponApplied = isRegionalCoupon({
				couponId,
				couponType:
					serverComputed.coupon?.id === couponId
						? serverComputed.coupon.type
						: null,
			})
			const existing = userId
				? await (deps.existingPurchases ?? loadExistingPurchases)(
						userId,
						productId,
					)
				: []
			const decision = duplicatePurchaseGuard({
				productType: await (deps.productType ?? loadProductType)(productId),
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
