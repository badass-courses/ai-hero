/**
 * The link a bulk buyer shares with their team. Anyone who signs in through
 * it claims a seat on the bulk coupon.
 */
export function getCouponInviteUrl(
	couponId: string,
	baseUrl: string | undefined = process.env.NEXT_PUBLIC_URL,
) {
	return `${baseUrl}?code=${couponId}`
}

/**
 * Only the buyer of a bulk purchase gets an invite link. Seat claimers have
 * `redeemedBulkCouponId` instead, so they get none.
 */
export function getTeamInviteUrlForPurchase(
	purchase: { bulkCouponId?: string | null },
	baseUrl?: string,
) {
	return purchase.bulkCouponId
		? getCouponInviteUrl(purchase.bulkCouponId, baseUrl)
		: undefined
}
