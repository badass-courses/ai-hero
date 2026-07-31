/**
 * A list's "home" href — where its sidebar entry and Overview row point.
 * Defaults to the list's own landing page (`/${slug}`); the override map is
 * for lists whose canonical landing is a dedicated page instead. The skills
 * list (`skills-catalog`) lives in the sidebar's Explore section as
 * `[Skills](/skills)` — /skills is its overview, so its sidebar entry expands
 * in place like any other series (no pinned duplicate). See
 * lat.md/decisions.md "Series posts keep the hub sidebar".
 *
 * Client-safe: no server imports (used by sidebar client components).
 */
const LIST_HOME_OVERRIDES: Record<string, string> = {
	'skills-catalog': '/skills',
}

/** Home href for a list slug: the override when set, else `/${slug}`. */
export function listHomeHref(slug: string): string {
	return LIST_HOME_OVERRIDES[slug] ?? `/${slug}`
}
