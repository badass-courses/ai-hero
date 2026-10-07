// Inclusion is fulfillment policy, not a course-sync resource relation.
export const INCLUDED_PRODUCTS: Readonly<
	Record<
		string,
		readonly {
			productId: string
			workshopId: string
			bundlePolicy: string
			idPrefix: string
		}[]
	>
> = {
	'product-s00zs': [
		{
			productId: 'product-ma254',
			workshopId: 'workshop-2ozd9',
			bundlePolicy: 'c5-includes-crash-course-v1',
			idPrefix: 'c5_cc_',
		},
	],
}

export function hasIncludedProductEntitlements(productId: string): boolean {
	return Boolean(INCLUDED_PRODUCTS[productId]?.length)
}
