/**
 * ⌘K search palette content config (wireframe 15).
 *
 * Client-safe (no server imports). Two Matt-controlled surfaces live here:
 *
 * 1. `CURATED_DEFAULTS` — what the palette shows before the visitor types.
 *    Not algorithmic recency: a hand-picked mix of the learning map, the
 *    latest skills update, featured posts, and mini courses. Edit freely;
 *    order is display order and the first item is pre-selected.
 * 2. `PALETTE_PROMO` — the promo row pinned between results and the keyboard
 *    hints. Usually the next Real Engineers cohort date; can be swapped for a
 *    live event or conference. The site-wide `FEATURED_PROMO` override in
 *    `../navigation/promo-config.ts` wins when set, so one featured promo can
 *    drive both the promo bar and the palette.
 */

import type { Promo } from '../navigation/promo-config'

/** Content-type hint rendered as the row icon. */
export type PaletteItemType =
	| 'map'
	| 'skill'
	| 'course'
	| 'post'
	| 'article'
	| 'tutorial'
	| 'workshop'
	| 'cohort'
	| 'lesson'
	| 'event'
	| 'dictionary'

export type PaletteItem = {
	title: string
	href: string
	type: PaletteItemType
}

export const CURATED_DEFAULTS: PaletteItem[] = [
	{ title: 'Start Here: the AI Coding Map', href: '/learn', type: 'map' },
	{ title: 'Skills — the full skill set', href: '/skills', type: 'skill' },
	{
		title: 'LLM Fundamentals',
		href: '/llm-fundamentals',
		type: 'tutorial',
	},
	{
		title: 'AI Engineer Roadmap',
		href: '/ai-engineer-roadmap',
		type: 'tutorial',
	},
	{
		title: 'AI Coding Dictionary',
		href: '/ai-coding-dictionary',
		type: 'dictionary',
	},
]

/**
 * Palette-local promo fallback. `FEATURED_PROMO` (site-wide) wins when set —
 * see `resolvePalettePromo` in `search-palette.tsx`.
 */
export const PALETTE_PROMO: Promo | null = {
	label: 'Cohort',
	message: 'AI Coding for Real Engineers — join the next live cohort',
	// Straight to the latest cohort's own page — /courses and /cohorts index
	// pages aren't built (decisions.md "Never link the /cohorts index").
	href: '/cohorts/ai-coding-for-real-engineers-m0k0w',
}
