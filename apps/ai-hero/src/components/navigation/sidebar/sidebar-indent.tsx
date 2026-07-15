'use client'

import * as React from 'react'

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

// Base leaves room in the gutter for a group label's disclosure chevron
// (pulled left with `-ms-5`) so labels and plain items share a left edge.
const INDENT_BASE = '1.25rem'
const INDENT_STEP = '0.75rem'

/** Left padding for a row at the given nesting depth. */
export function rowIndent(depth: number): React.CSSProperties {
	return {
		paddingInlineStart: `calc(${INDENT_BASE} + ${depth} * ${INDENT_STEP})`,
	}
}
