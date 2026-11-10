import type Stripe from 'stripe'

import type { TeamInvoiceProduct } from './create-team-invoice'
import { resolveMerchantIds, type MerchantIdsAdapter } from './merchant-ids'

export type LoadProductDeps = {
	adapter: MerchantIdsAdapter & {
		getProduct(productId: string): Promise<
			| (TeamInvoiceProduct['product'] & {
					quantityAvailable?: number | null
			  })
			| null
		>
	}
	stripe: Pick<Stripe, 'prices'>
	purchaseCount: (productId: string) => Promise<number>
	openInvoices: (productId: string) => Promise<{ seats: number }[]>
}

/**
 * The product a team invoice is for: the app product, its Stripe price and
 * product, how many seats are sold, and the open invoices holding seats on a
 * limited product. Null when anything needed to invoice it is missing.
 */
export async function loadTeamInvoiceProduct(
	deps: LoadProductDeps,
	productId: string,
): Promise<TeamInvoiceProduct | null> {
	const [product, merchantIds, purchaseCount] = await Promise.all([
		deps.adapter.getProduct(productId),
		resolveMerchantIds(deps.adapter, productId),
		deps.purchaseCount(productId),
	])
	if (!product || !merchantIds) return null
	const { stripePriceId, stripeProductId } = merchantIds
	// The invoice line is the Stripe price, so its amount is the list price
	// the discount works from, not the app's copy of it.
	const stripePrice = await deps.stripe.prices.retrieve(stripePriceId)
	if (
		!stripePrice.active ||
		stripePrice.currency !== 'usd' ||
		stripePrice.type !== 'one_time' ||
		typeof stripePrice.unit_amount !== 'number'
	) {
		return null
	}
	// Only a limited product needs its open invoices counted.
	const limited = (product.quantityAvailable ?? -1) >= 0
	const heldSeats = limited
		? (await deps.openInvoices(productId)).reduce(
				(sum, invoice) => sum + invoice.seats,
				0,
			)
		: 0
	return {
		product: {
			...product,
			quantityAvailable: product.quantityAvailable,
		},
		purchaseCount,
		heldSeats,
		stripePriceId,
		stripeProductId,
		listUnitAmount: stripePrice.unit_amount,
	}
}
