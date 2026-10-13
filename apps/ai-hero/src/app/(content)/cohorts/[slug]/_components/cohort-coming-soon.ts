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

/** Where a published cohort product sits relative to its enrollment window. */
export type CohortEnrollmentPhase = 'before-open' | 'open' | 'closed'

/**
 * The one reading of `openEnrollment` and `closeEnrollment` for the page.
 * Bounds are exclusive, as they always were: at the exact open instant the
 * window is not open yet, and at the exact close instant it has closed.
 * No open date means no restriction.
 *
 * @param now - The current instant. Time zones do not matter: dates are instants.
 * @param openEnrollment - `product.fields.openEnrollment`, an ISO string.
 * @param closeEnrollment - `product.fields.closeEnrollment`, an ISO string.
 */
export function cohortEnrollmentPhase({
	now,
	openEnrollment,
	closeEnrollment,
}: {
	now: Date
	openEnrollment: string | null | undefined
	closeEnrollment: string | null | undefined
}): CohortEnrollmentPhase {
	if (!openEnrollment) return 'open'
	if (now.getTime() <= new Date(openEnrollment).getTime()) return 'before-open'
	if (closeEnrollment && now.getTime() >= new Date(closeEnrollment).getTime())
		return 'closed'
	return 'open'
}

/**
 * What the rail is offering, as the one answer the phone's bottom bar, the
 * inline `<Enroll>` buttons and the `<CanEnroll>` guard all read.
 *
 * - `enroll`: seats can be bought. Gold "Enroll Now".
 * - `waitlist`: there is a product, and nothing to buy yet. Gold "Join Waitlist".
 * - `on-waitlist`: they already joined. A status, and no ask.
 * - `owned`: they have the cohort. An outline way to its workshops.
 * - `none`: no product to act on, so there is no bar and no button.
 */
export type CohortMobileCta =
	| 'enroll'
	| 'waitlist'
	| 'on-waitlist'
	| 'owned'
	| 'none'

/**
 * Everything outside the rail that asks for action, decided together so the
 * mobile bar, inline `<Enroll>` buttons and the JSON-LD offer cannot disagree.
 * When there is nothing to buy (coming soon, or published but outside the
 * enrollment window) the rail is the waitlist, and so is everything else.
 *
 * @param phase - From {@link cohortEnrollmentPhase}.
 * @param productState - `product.fields.state`, undefined when there is no product.
 * @param allowPurchase - The `allowPurchase` search param.
 * @param hasCohortAccess - Whether the viewer already has the cohort.
 * @param isOnWaitlist - Whether the viewer already joined this cohort's waitlist.
 * @param hasActiveProduct - There is a product and it has not been retired;
 *   the rail holds nothing without one.
 * @param bypassSoldOut - The viewer's coupon lets them buy outside the window,
 *   as it does in the rail.
 * @returns `canEnroll` for buying, `mobileCta` for the bar and the inline
 *   buttons, whether JSON-LD may describe an offer, and `curriculumAnnounced`:
 *   the workshop list shows to someone who can buy or already has the cohort,
 *   and on a cohort whose window has closed, but never on a page that is
 *   still the waitlist for a launch.
 */
export function cohortCallsToAction({
	phase,
	productState,
	allowPurchase,
	hasCohortAccess,
	isOnWaitlist,
	hasActiveProduct,
	bypassSoldOut,
}: {
	phase: CohortEnrollmentPhase
	productState: string | undefined
	allowPurchase: unknown
	hasCohortAccess: boolean
	isOnWaitlist: boolean
	hasActiveProduct: boolean
	bypassSoldOut: boolean
}) {
	const isComingSoon = isCohortComingSoon({
		productState,
		allowPurchase,
		hasCohortAccess,
	})
	const canEnroll =
		allowPurchase === 'true' ||
		(productState === 'published' && (phase === 'open' || bypassSoldOut))
	const isWaitlistOnly = !hasCohortAccess && (isComingSoon || !canEnroll)
	const mobileCta: CohortMobileCta = hasCohortAccess
		? 'owned'
		: !hasActiveProduct
			? 'none'
			: isWaitlistOnly
				? isOnWaitlist
					? 'on-waitlist'
					: 'waitlist'
				: 'enroll'
	return {
		isComingSoon,
		canEnroll,
		isWaitlistOnly,
		mobileCta,
		offerInJsonLd: hasActiveProduct && !isWaitlistOnly,
		curriculumAnnounced:
			mobileCta === 'enroll' ||
			mobileCta === 'owned' ||
			(!isComingSoon && phase !== 'before-open'),
	}
}
