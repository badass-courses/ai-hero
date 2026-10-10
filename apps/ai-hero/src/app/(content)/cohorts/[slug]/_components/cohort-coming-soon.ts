/**
 * A cohort page is "coming soon" when there is a product to wait for but
 * nothing to buy yet: the product is still `draft` and nobody passed the
 * `allowPurchase` override. Until now that state rendered an empty rail with
 * no way to leave an email, plus an "Enroll Now" bar on mobile pointing at it.
 *
 * Purchasers and admins (`hasCohortAccess`) keep their own rail, so they never
 * see the waitlist.
 *
 * @param productState - `product.fields.state`, undefined when there is no product.
 * @param allowPurchase - The `allowPurchase` search param.
 * @param hasCohortAccess - Whether the viewer already has the cohort.
 * @returns True when the page should show the waitlist instead of pricing.
 */
export function isCohortComingSoon({
	productState,
	allowPurchase,
	hasCohortAccess,
}: {
	productState: string | undefined
	allowPurchase: unknown
	hasCohortAccess: boolean
}) {
	if (hasCohortAccess) return false
	if (allowPurchase === 'true') return false
	return productState !== undefined && productState !== 'published'
}
