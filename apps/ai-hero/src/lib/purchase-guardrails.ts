import type { Purchase } from '@coursebuilder/core/schemas'

export const DUPLICATE_GUARDRAIL_PRODUCT_TYPES = [
	'cohort',
	'cohort-archive',
] as const

/** Returns true when this product type should block duplicate active purchases. */
export const requiresDuplicateActivePurchaseGuardrail = (
	productType?: string | null,
) => {
	return DUPLICATE_GUARDRAIL_PRODUCT_TYPES.includes(
		productType as (typeof DUPLICATE_GUARDRAIL_PRODUCT_TYPES)[number],
	)
}

/** Returns true when a user already has an active non-bulk purchase for the given product. */
export const hasActiveNonBulkPurchaseForProduct = (
	purchases: Array<Pick<Purchase, 'productId' | 'status' | 'bulkCouponId'>>,
	productId: string,
) => {
	return purchases.some((purchase) => {
		return (
			purchase.productId === productId &&
			['Valid', 'Restricted'].includes(purchase.status) &&
			!purchase.bulkCouponId
		)
	})
}

/** `reason` on /subscribe/error for a regional coupon on a team order. */
export const REGIONAL_TEAM_NOT_ALLOWED = 'regional-team-not-allowed'

export const REGIONAL_TEAM_NOT_ALLOWED_PATH = `/subscribe/error?reason=${REGIONAL_TEAM_NOT_ALLOWED}`

export type DuplicatePurchaseDecision =
	| 'allow'
	| 'already-own'
	| 'regional-team-not-allowed'

/**
 * The one decision for "may this buyer start this checkout?".
 * - Team orders (quantity >= 2) always pass the duplicate guard, so a seat
 *   holder, regional holders included, can buy team seats. A team order must
 *   never carry a regional (PPP) coupon.
 * - A single seat is blocked when the buyer already holds an active non-bulk
 *   purchase of a guarded product type.
 */
export const duplicatePurchaseGuard = ({
	productType,
	quantity,
	existing,
	regionalCouponApplied,
}: {
	productType?: string | null
	quantity: number
	existing: Array<{ status: string; bulk: boolean }>
	regionalCouponApplied: boolean
}): DuplicatePurchaseDecision => {
	if (quantity >= 2) {
		return regionalCouponApplied ? 'regional-team-not-allowed' : 'allow'
	}
	if (!requiresDuplicateActivePurchaseGuardrail(productType)) return 'allow'
	const owns = existing.some(
		(purchase) =>
			['Valid', 'Restricted'].includes(purchase.status) && !purchase.bulk,
	)
	return owns ? 'already-own' : 'allow'
}
