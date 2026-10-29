/**
 * The Stripe price and product behind an app product, found the way checkout
 * finds them (`resolveCheckoutPrice`): the merchant product by product id,
 * then the merchant price by the merchant product's own id. The drizzle
 * adapter's `getMerchantPriceForProductId` takes a *merchant product* id, so
 * handing it the app's product id never matches and every product looks like
 * it has no Stripe price.
 */

type MerchantRow = { id: string; identifier?: string | null; status?: number }

export type MerchantIdsAdapter = {
	getPriceForProduct(productId: string): Promise<{ id: string } | null>
	getMerchantProductForProductId(productId: string): Promise<MerchantRow | null>
	getMerchantPriceForPriceId?(
		merchantProductId: string,
		priceId: string,
	): Promise<MerchantRow | null>
	getMerchantPriceForProductId(
		merchantProductId: string,
	): Promise<MerchantRow | null>
}

export async function resolveMerchantIds(
	adapter: MerchantIdsAdapter,
	productId: string,
): Promise<{ stripePriceId: string; stripeProductId: string } | null> {
	const merchantProduct = await adapter.getMerchantProductForProductId(productId)
	if (!merchantProduct?.identifier || merchantProduct.status !== 1) return null

	let merchantPrice: MerchantRow | null
	if (adapter.getMerchantPriceForPriceId) {
		const price = await adapter.getPriceForProduct(productId)
		if (!price) return null
		merchantPrice = await adapter.getMerchantPriceForPriceId(
			merchantProduct.id,
			price.id,
		)
	} else {
		merchantPrice = await adapter.getMerchantPriceForProductId(
			merchantProduct.id,
		)
	}
	if (!merchantPrice?.identifier || merchantPrice.status !== 1) return null

	return {
		stripePriceId: merchantPrice.identifier,
		stripeProductId: merchantProduct.identifier,
	}
}
