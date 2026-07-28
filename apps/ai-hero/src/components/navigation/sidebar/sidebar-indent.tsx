'use client'

import * as React from 'react'
import { TYPE } from '@/components/landing/type'

import { cn } from '@coursebuilder/ui/utils/cn'

/**
 * Sidebar indentation, handled by nesting DEPTH rather than ad-hoc `pl-*` per
 * component. Depth 0 = a top-level row (Explore/tentpole link, topic label,
 * What's New post). Each collapsible group (`SidebarSection`, an expanded list)
 * wraps its rows in `<SidebarDepth>`, bumping them one level. Every row applies
 * `rowIndent(depth)` as its left padding — the single source of truth — so the
 * containers themselves add no horizontal padding.
 */
const SidebarDepthContext = React.createContext(0)

export function useSidebarDepth(): number {
	return React.useContext(SidebarDepthContext)
}

/** Wrap a subtree to render its rows one nesting level deeper. */
export function SidebarDepth({ children }: { children: React.ReactNode }) {
	const depth = React.useContext(SidebarDepthContext)
	return (
		<SidebarDepthContext.Provider value={depth + 1}>
			{children}
		</SidebarDepthContext.Provider>
	)
}

// The prototype's two measured values (`.ah-sidebar__item` / `__lesson`): a
// top-level row pads 10px inside the shell's 18px gutter, and a nested lesson
// row pads 28px — an 18px step. Chevrons sit on the RIGHT now, so the base is
// no longer a gutter reserved for them; it is simply the row's own padding.
const INDENT_BASE = '0.625rem'
const INDENT_STEP = '1.125rem'

/** Left padding for a row at the given nesting depth. */
export function rowIndent(depth: number): React.CSSProperties {
	return {
		paddingInlineStart: `calc(${INDENT_BASE} + ${depth} * ${INDENT_STEP})`,
	}
}

/**
 * The metrics every sidebar row shares (`.ah-sidebar__item`): 13.5/1.4, a 7px
 * vertical pad, a 9px gap to the leading 16px glyph slot, and the small radius
 * — 6px, not the 11px `rounded-md` the primitive defaults to, which on a 33px
 * row reads as a pill rather than as a highlight. Left padding is NOT here: it
 * comes from `rowIndent(depth)`, so nesting owns it.
 *
 * These live in this module rather than in `sidebar-client` because
 * `series-lessons` needs them too and `sidebar-client` imports IT — the same
 * cycle its local `norm()` already dodges.
 */
export const SIDEBAR_ROW_CLASS = cn(
	TYPE.nav,
	'text-muted-foreground h-auto gap-[9px] rounded-sm py-[7px] pr-2.5 font-normal',
)

/**
 * A nested row — a lesson, a series section header. One step down from
 * `SIDEBAR_ROW_CLASS` in size (13/1.35, `.ah-sidebar__lesson`) so a disclosed
 * list reads as its parent row's contents rather than as more siblings.
 * `items-start` because these titles wrap and the numeral must hold the first
 * line, not the middle of the block.
 */
export const SIDEBAR_NESTED_ROW_CLASS = cn(
	TYPE.metaSm,
	// Tight gap and trailing pad: in a 264px rail every pixel spent left of the
	// title is a pixel of title that wraps. Lesson titles are the longest text
	// in the sidebar and the thing people actually scan.
	'text-muted-foreground h-auto items-start gap-1.5 rounded-sm py-[7px] pr-2 font-normal',
)

/**
 * The leading numeral slot on a nested row (`.ah-sidebar__num`). `h-[18px]`
 * matches `metaSm`'s line box, so a `leading-none` numeral centres on the
 * title's first line instead of floating above it.
 */
export const SIDEBAR_NUM_CLASS = cn(
	TYPE.navNum,
	'flex h-[18px] shrink-0 items-center',
)

/**
 * The group eyebrow ("Explore", "Topics") — the prototype's `.eb`: mono, 9.5px,
 * caps, 0.14em. It was 11px semibold DM Sans, which put it in the same typeface
 * and nearly the same size as the rows under it, so the column read as one
 * undifferentiated list; mono and caps are what make it a label instead of just
 * a smaller item.
 *
 * `px-2.5` is deliberate: the eyebrow indents to the rows' own 10px padding, so
 * it aligns with their glyph slot rather than sitting flush to the gutter.
 * Spacing carries the group rhythm — 26px above, 9px below — with `first:pt-0`
 * because the shell's own `pt-6` already opens the column.
 */
export const SIDEBAR_LABEL_CLASS = cn(
	TYPE.micro,
	'h-auto px-2.5 pb-[9px] pt-[26px] text-[color:var(--ah-fg-label)] first:pt-0',
)
