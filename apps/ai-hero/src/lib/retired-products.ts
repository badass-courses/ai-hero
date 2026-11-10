/**
 * Products we no longer sell. Their content is free to everyone, so a
 * workshop that one of them sells shows no pricing and checkout refuses them.
 *
 * Retiring stops new sales only. Owners keep their purchases, receipts,
 * entitlements and unused team seats exactly as they are, and nothing changes
 * in Stripe.
 *
 * - `product-9wdta`, AI SDK v6 Crash Course: made free and marked deprecated
 *   along with Evalite (Joel, 2026-11-05).
 */
export const RETIRED_PRODUCT_IDS: ReadonlySet<string> = new Set([
	'product-9wdta',
])

/** Why checkout refused: the product is retired and its content is free. */
export const RETIRED_PRODUCT_REASON = 'product-retired'

export function isRetiredProduct(
	productId: string | null | undefined,
): boolean {
	return productId != null && RETIRED_PRODUCT_IDS.has(productId)
}

/**
 * A workshop sold by a retired product sells nothing: not the retired
 * product, and not any older product that happens to be attached to the same
 * workshop (the AI SDK workshop is also inside a past cohort's bundle).
 */
export function withoutRetiredWorkshopProducts<T extends { id: string }>(
	products: readonly T[],
): T[] {
	return products.some((product) => isRetiredProduct(product.id))
		? []
		: [...products]
}
