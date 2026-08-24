/**
 * Site-wide promo bar content (Phase 7). One active message at a time.
 *
 * Resolution order (see `promo-bar.tsx`):
 * 1. `FEATURED_PROMO` manual override, when set.
 * 2. Fallback to the latest published, public post.
 *
 * Client-safe (no server imports): just the manual-override config + types.
 * The bar is server-rendered and NOT dismissible, so there is no cookie/state
 * and no layout shift. See plans/navigation-redesign.md.
 */

export type Promo = {
	/** Optional mono badge, e.g. "New", "Cohort", "Talk". */
	label?: string
	/** The promo headline. Keep it short for one line on mobile. */
	message: string
	href: string
	/** Resource id used to suppress owned offers in the global nav. */
	resourceId?: string
	/** Compact copy for the nav's single gold action. */
	navLabel?: string
	/** Direct page path so the nav can hide itself on the sold page. */
	navHref?: string
	/** Optional ISO instant before which this promo stays hidden. */
	startsAt?: string
}

export const CRASH_COURSE_PRODUCT_ID = 'product-ma254'
export const CRASH_COURSE_RESOURCE_ID = 'workshop-2ozd9'
export const CRASH_COURSE_PROMO_STARTS_AT = '2026-08-17T07:00:00.000Z'

const PRODUCT_PROMO_STARTS_AT: Readonly<Record<string, string>> = {
	[CRASH_COURSE_PRODUCT_ID]: CRASH_COURSE_PROMO_STARTS_AT,
}

export function isPromoActive(
	promo: Promo | null,
	now: Date = new Date(),
): promo is Promo {
	if (!promo) return false
	if (!promo.startsAt) return true
	return now.getTime() >= new Date(promo.startsAt).getTime()
}

export function isProductPromoActive(
	productId: string | null | undefined,
	now: Date = new Date(),
): boolean {
	if (!productId) return true
	const startsAt = PRODUCT_PROMO_STARTS_AT[productId]
	if (!startsAt) return true
	return now.getTime() >= new Date(startsAt).getTime()
}

/**
 * Manual override. It becomes visible at midnight Pacific on launch day.
 * Before then the site keeps the latest-post fallback.
 */
export const FEATURED_PROMO: Promo = {
	label: 'New',
	message: 'AI Coding Crash Course is open. $199 through August 24.',
	href: '/s/crash-course',
	resourceId: CRASH_COURSE_RESOURCE_ID,
	navLabel: 'Save $100',
	navHref: '/workshops/ai-coding-crash-course',
	startsAt: CRASH_COURSE_PROMO_STARTS_AT,
}
