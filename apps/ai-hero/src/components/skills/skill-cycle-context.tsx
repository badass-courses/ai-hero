'use client'

/**
 * Shared hover state for the skill cycle diagram and any sibling catalog
 * card list (spec: w2-skills-pages §4 "Hover-sync design").
 *
 * The cycle diagram and the catalog cards on /skills are separate DOM
 * subtrees; this provider lifts the hovered-skill slug so hovering either
 * half highlights both, without prop-drilling through the page.
 *
 * Usage (W2 /skills landing):
 *
 * ```tsx
 * <SkillCycleHoverProvider>
 *   <SkillCycle skills={core} utilitySkills={utility} />
 *   <SkillCatalog skills={core} /> // calls useSkillCycleHover() itself
 * </SkillCycleHoverProvider>
 * ```
 *
 * When no provider is mounted (W4 homepage), `useSkillCycleHover()` returns
 * `null` and `SkillCycle` falls back to its own internal state.
 */

import * as React from 'react'

export type SkillCycleHoverValue = {
	/** Flat slug of the currently hovered/focused skill, or null. */
	hoveredSlug: string | null
	setHoveredSlug: (slug: string | null) => void
}

const SkillCycleHoverContext =
	React.createContext<SkillCycleHoverValue | null>(null)

export function SkillCycleHoverProvider({
	children,
}: {
	children: React.ReactNode
}) {
	const [hoveredSlug, setHoveredSlug] = React.useState<string | null>(null)
	const value = React.useMemo(
		() => ({ hoveredSlug, setHoveredSlug }),
		[hoveredSlug],
	)
	return (
		<SkillCycleHoverContext.Provider value={value}>
			{children}
		</SkillCycleHoverContext.Provider>
	)
}

/**
 * Returns the shared hover state, or `null` when rendered outside a
 * `SkillCycleHoverProvider` (standalone usage, e.g. the homepage).
 */
export function useSkillCycleHover(): SkillCycleHoverValue | null {
	return React.useContext(SkillCycleHoverContext)
}
