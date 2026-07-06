/**
 * Primary (global) navigation destinations for the redesigned top nav.
 *
 * Labels and hrefs live here as single sources of truth so naming decisions
 * still open in `plans/navigation-redesign.md` (e.g. "Start Here" vs another
 * label, "Courses" vs "Workshops", the final hub URL) are one-line changes.
 *
 * Mode usage (see `nav-mode.ts`):
 * - full + hub: PRIMARY_LEARNING_ENTRY (emphasized) + PRIMARY_NAV_ITEMS. The
 *   top nav is identical in both modes; hub pages additionally get the docs
 *   sidebar. (The wireframe's "..." on hub pages meant "same items as the
 *   homepage", not a collapsed nav.)
 * - minimal: no center nav.
 */

export type PrimaryNavItem = {
	label: string
	href: string
}

/** The emphasized first item — the primary free-learning entry point. */
export const PRIMARY_LEARNING_ENTRY: PrimaryNavItem = {
	label: 'Start Here',
	href: '/learn',
}

/** Persistent revenue path. Kept visible in both full and hub modes. */
export const COURSES_NAV_ITEM: PrimaryNavItem = {
	label: 'Courses',
	href: '/courses',
}

/** Global destinations after the primary entry, in display order. */
export const PRIMARY_NAV_ITEMS: PrimaryNavItem[] = [
	{ label: 'Principles', href: '/principles' },
	{ label: 'Skills', href: '/skills' },
	{ label: 'Tools', href: '/tools' },
	COURSES_NAV_ITEM,
]
