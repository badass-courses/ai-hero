export const INCLUDED_PRODUCT_ENTITLEMENTS_RETRY_EVENT =
	'commerce/included-product-entitlements-retry-requested'

export type IncludedProductEntitlementsRetry = {
	data: {
		purchaseId: string
		productId: string
		userId: string
		organizationId: string
		organizationMembershipId: string
	}
}
