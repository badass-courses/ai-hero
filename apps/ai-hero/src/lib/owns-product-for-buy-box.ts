/**
 * DISPLAY-ONLY. Decides whether a buy box should say "you own this" and hide
 * the Buy button. It is not an entitlement or access check and must never be
 * imported by ability, entitlement or access code (see the fence test).
 *
 * A viewer owns a product for the buy box when one of their purchases of that
 * product is Valid or Restricted and is not a bulk purchase. A bulk purchase
 * grants the team manager no seat; a redeemed seat is its own non-bulk
 * purchase, so it counts.
 */
export type BuyBoxPurchase = {
	productId: string
	status: string
	bulkCouponId?: string | null
}

const OWNING_STATUSES = new Set(['Valid', 'Restricted'])

export function ownsProductForBuyBox(
	purchases: ReadonlyArray<BuyBoxPurchase> | null | undefined,
	productId: string | null | undefined,
): boolean {
	if (!purchases || !productId) return false
	return purchases.some(
		(purchase) =>
			purchase.productId === productId &&
			OWNING_STATUSES.has(purchase.status) &&
			!purchase.bulkCouponId,
	)
}
