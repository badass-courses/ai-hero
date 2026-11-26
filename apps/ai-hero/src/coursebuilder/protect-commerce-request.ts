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
	return await (
		lookup ??
		(async (id: string) =>
			(await courseBuilderAdapter.getMerchantCoupon(id))?.type)
	)(couponId)
}

const loadProductType = async (productId: string) =>
	(await getProduct(productId))?.type

/**
 * Authorization runs before any pricing: synthetic principals and buyers who
 * lost a chargeback are refused here, so the authoritative-price hook never
 * sees their checkout.
 *
 * The duplicate-purchase decision runs before coupon work. The regional-team
 * guard runs on the final selection, after coupon authorization. verify-login
 * is only a convenience hop; its approval is not bound to this POST.
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
): Promise<{
	request: NextRequest | Response
	userId?: string
	paidCouponUsedUp?: true
}> => {
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
	const redirectTo = (path: string) => ({
		request: Response.redirect(new URL(path, request.url), 303),
		userId,
	})
	let quantity: number | null = 1
	if (isCheckoutRequest(request)) {
		// Course Builder uses Object.fromEntries: the last repeated key wins.
		const param = (key: string) =>
			request.nextUrl.searchParams.getAll(key).at(-1)
		quantity = parseCheckoutQuantity(param('quantity'))
		if (quantity === null) return redirectTo(INVALID_QUANTITY_PATH)
		const productId = param('productId')
		if (productId && quantity < 2 && userId) {
			const existing = await (deps.existingPurchases ?? loadExistingPurchases)(
				userId,
				productId,
			)
			const decision = duplicatePurchaseGuard({
				productType: await (deps.productType ?? loadProductType)(productId),
				quantity,
				existing,
				regionalCouponApplied: false,
			})
			if (decision === 'already-own') {
				return redirectTo(
					AUTHORITATIVE_PRODUCT_IDS.has(productId) &&
						existing.some((purchase) => purchase.status === 'Restricted')
						? REGIONAL_UPGRADE_PATH
						: ALREADY_OWN_PATH,
				)
			}
		}
	}
	const serverComputed: {
		coupon?: { id: string; type?: string | null } | null
	} = {}
	let paidCouponUsedUp: true | undefined
	const guarded = await protectCourseBuilderRequest(request, {
		onPaidCouponUsedUp: () => {
			paidCouponUsedUp = true
		},
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
	if (
		isCheckoutRequest(request) &&
		quantity >= 2 &&
		guarded.nextUrl.searchParams.has('productId')
	) {
		// Team guard reads the final coupon, including any server-computed selection.
		const couponId =
			guarded.nextUrl.searchParams.getAll('couponId').at(-1) ?? null
		if (
			isRegionalCoupon({
				couponId,
				couponType: await finalCouponType(
					couponId,
					serverComputed.coupon,
					deps.couponType,
				),
			})
		)
			return redirectTo(REGIONAL_TEAM_NOT_ALLOWED_PATH)
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
	return {
		request: guarded,
		userId,
		...(paidCouponUsedUp && { paidCouponUsedUp }),
	}
}
