/**
 * What the cohort rail is offering, as answers the rail and the phone's bottom
 * bar both read. They used to work it out separately, and the bar said
 * "Enroll Now" over a rail that held a waitlist, a confirmation, or the
 * workshops of someone who already owned the cohort.
 */

/** Whether seats can be bought right now, by the product's enrollment dates. */
export type CohortEnrollmentWindow = 'open' | 'not-open' | 'closed'

/**
 * A product with no opening date is closed, not open: a cohort is sold in a
 * window, and one that has not been given a window is not on sale yet.
 *
 * @param bypassSoldOut - A coupon that lets its holder buy regardless.
 */
export function getCohortEnrollmentWindow({
	openEnrollment,
	closeEnrollment,
	bypassSoldOut = false,
	now = new Date(),
}: {
	openEnrollment: string | null | undefined
	closeEnrollment: string | null | undefined
	bypassSoldOut?: boolean
	now?: Date
}): CohortEnrollmentWindow {
	if (bypassSoldOut) return 'open'
	if (!openEnrollment) return 'closed'
	const opensAt = new Date(openEnrollment)
	if (opensAt > now) return 'not-open'
	const stillOpen = closeEnrollment ? new Date(closeEnrollment) > now : true
	return opensAt < now && stillOpen ? 'open' : 'closed'
}

/**
 * The bottom bar's one control.
 *
 * - `enroll`: the rail has the pricing card. Gold "Enroll Now".
 * - `waitlist`: the rail has the waitlist form. Gold "Join Waitlist".
 * - `on-waitlist`: they already joined. A status, and no ask.
 * - `owned`: they have the cohort. An outline way to its workshops.
 * - `none`: the rail offers nothing to act on, so there is no bar.
 */
export type CohortMobileCta =
	| 'enroll'
	| 'waitlist'
	| 'on-waitlist'
	| 'owned'
	| 'none'

/**
 * @param railHasOffer - The pricing container is rendered: the product is
 *   published or `allowPurchase` forced it.
 * @param hasActiveProduct - There is a product and it has not been retired.
 * @param allowPurchase - The `allowPurchase` search param; any value shows the
 *   pricing card whatever the dates say.
 */
export function getCohortMobileCta({
	hasCohortAccess,
	isComingSoon,
	isOnWaitlist,
	railHasOffer,
	hasActiveProduct,
	allowPurchase,
	enrollmentWindow,
}: {
	hasCohortAccess: boolean
	isComingSoon: boolean
	isOnWaitlist: boolean
	railHasOffer: boolean
	hasActiveProduct: boolean
	allowPurchase: unknown
	enrollmentWindow: CohortEnrollmentWindow
}): CohortMobileCta {
	if (hasCohortAccess) return 'owned'
	if (!hasActiveProduct) return 'none'
	const waitlist = isOnWaitlist ? 'on-waitlist' : 'waitlist'
	if (isComingSoon) return waitlist
	if (!railHasOffer) return 'none'
	return allowPurchase || enrollmentWindow === 'open' ? 'enroll' : waitlist
}
