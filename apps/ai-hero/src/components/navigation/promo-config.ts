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
}

/**
 * Manual override. Set to a Promo to feature it site-wide (wins over the
 * latest-post fallback); leave `null` to fall back automatically.
 */
export const FEATURED_PROMO: Promo | null = null
