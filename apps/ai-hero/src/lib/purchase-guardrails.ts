import type { Purchase } from '@coursebuilder/core/schemas'

export const DUPLICATE_GUARDRAIL_PRODUCT_TYPES = [
	'cohort',
	'cohort-archive',
] as const

export const requiresDuplicateActivePurchaseGuardrail = (
	productType?: string | null,
) => {
	return DUPLICATE_GUARDRAIL_PRODUCT_TYPES.includes(
		productType as (typeof DUPLICATE_GUARDRAIL_PRODUCT_TYPES)[number],
	)
}

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
