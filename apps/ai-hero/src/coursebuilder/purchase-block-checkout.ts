import { PURCHASE_BLOCKED } from '@/lib/purchase-block'
import { isUserBlockedFromPurchasing } from '@/lib/purchase-disputes'

export const PURCHASE_BLOCKED_ERROR_PATH = `/subscribe/error?reason=${PURCHASE_BLOCKED}`

/**
 * A buyer who lost a chargeback never reaches Stripe again. Returns a redirect
 * to the support message for a checkout request by a blocked user; undefined
 * lets the request through. Logged-out checkouts carry no user to check.
 */
export async function purchaseBlockedCheckoutRefusal(
	requestUrl: string,
	pathname: string,
	userId: string | null | undefined,
	isBlocked: (userId: string) => Promise<boolean> = isUserBlockedFromPurchasing,
): Promise<Response | undefined> {
	if (!pathname.includes('/checkout/') || !userId) return undefined
	if (!(await isBlocked(userId))) return undefined
	return Response.redirect(
		new URL(PURCHASE_BLOCKED_ERROR_PATH, requestUrl),
		303,
	)
}
