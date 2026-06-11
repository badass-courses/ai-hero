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
