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
	/**
	 * Optional ISO instant at which this promo retires itself.
	 *
	 * REQUIRED on any message that makes a dated or priced claim. Without it a
	 * promo is a standing assertion: on 2026-08-25 the bar was still saying
	 * "$199 through August 24" — the intro coupon had expired at 06:59:59Z and
	 * the course was back to $299, and nothing in the config knew. One stale
	 * string became three wrong claims, because `FEATURED_PROMO` also drives
	 * the nav's gold CTA and the search palette.
	 *
	 * A promo with no expiry is fine — but only when its copy stays true
	 * indefinitely, which in practice means naming no price and no date.
	 */
	endsAt?: string
}

export const CRASH_COURSE_PRODUCT_ID = 'product-ma254'
export const CRASH_COURSE_RESOURCE_ID = 'workshop-2ozd9'
export const CRASH_COURSE_PROMO_STARTS_AT = '2026-08-17T07:00:00.000Z'

const PRODUCT_PROMO_STARTS_AT: Readonly<Record<string, string>> = {
	[CRASH_COURSE_PRODUCT_ID]: CRASH_COURSE_PROMO_STARTS_AT,
}

/**
 * Is this promo inside its live window right now?
 *
 * Both bounds are optional and the window is half-open: live from `startsAt`
 * inclusive until `endsAt` exclusive. A promo with neither bound is always
 * live, which is only safe for copy that names no price and no date.
 */
export function isPromoActive(
	promo: Promo | null,
	now: Date = new Date(),
): promo is Promo {
	if (!promo) return false
	const at = now.getTime()
	if (promo.startsAt && at < new Date(promo.startsAt).getTime()) return false
	if (promo.endsAt && at >= new Date(promo.endsAt).getTime()) return false
	return true
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
 *
 * Deliberately says nothing about price or dates. It used to carry the intro
 * offer ("$199 through August 24", nav "Save $100"), which stopped being true
 * the moment the default $100-off coupon lapsed at 2026-08-25T06:59:59Z — see
 * `endsAt` above. The course is $299 now; the bar's job after a launch is to
 * point at the thing, and the product page is where the price is authoritative
 * and always current. Re-adding a priced claim here means adding an `endsAt`
 * with it.
 */
export const FEATURED_PROMO: Promo = {
	label: 'New',
	message: 'AI Coding Crash Course is out now.',
	href: '/s/crash-course',
	resourceId: CRASH_COURSE_RESOURCE_ID,
	navLabel: 'Get the course',
	navHref: '/workshops/ai-coding-crash-course',
	startsAt: CRASH_COURSE_PROMO_STARTS_AT,
}
