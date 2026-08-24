export type CouponLookup<T> = (couponCodeOrId: string | null) => Promise<T>

/**
 * Course Builder's coupon provider asks for a coupon on every mount, even when
 * the URL has no coupon. Keep that empty lookup in the browser so a public page
 * load does not create a server-action POST to the page route.
 */
export function ignoreEmptyCouponLookup<T>(
	lookup: CouponLookup<T>,
): CouponLookup<T | undefined> {
	return (couponCodeOrId) =>
		couponCodeOrId ? lookup(couponCodeOrId) : Promise.resolve(undefined)
}
