'use client'

/**
 * Skill catalog grid for the /skills landing (spec §7 step 3). Renders the
 * browsable card list that sits below the SkillCycle diagram: core skill cards
 * (title, tagline, phase badge) in cycle order, plus a distinct-tint 3-column
 * utility row.
 *
 * Both halves consume `useSkillCycleHover()` so hovering (or focusing) a card
 * here highlights the matching cycle node above and vice-versa. Highlight is
 * ring + opacity only, never color (DESIGN.md §7). Every card is a real flat
 * `/{slug}` link; hover is decoration, not navigation.
 */

import * as React from 'react'
import Link from 'next/link'
import { type SkillEntry } from '@/lib/skills-shared'

import { cn } from '@coursebuilder/utils/cn'

import { useSkillCycleHover } from '@/components/skills'

export function SkillsCatalog({
	skills,
	utilitySkills,
}: {
	/** Core skill entries in cycle order (position order). */
	skills: SkillEntry[]
	/** Utility skills for the distinct-tint 3-column row. */
	utilitySkills: SkillEntry[]
}) {
	const context = useSkillCycleHover()
	const hoveredSlug = context?.hoveredSlug ?? null
	const setHoveredSlug = context?.setHoveredSlug ?? (() => {})

	if (skills.length === 0 && utilitySkills.length === 0) return null

	return (
		<div className="border-b">
			<div className="px-6 pb-3 pt-8 sm:px-8">
				<span className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					Browse every skill
				</span>
			</div>

			{skills.length > 0 ? (
				<div className="border-border bg-border grid grid-cols-1 gap-px border-y sm:grid-cols-2 lg:grid-cols-3">
					{skills.map((entry) => (
						<SkillCard
							key={entry.id}
							entry={entry}
							tint="card"
							hoveredSlug={hoveredSlug}
							setHoveredSlug={setHoveredSlug}
						/>
					))}
				</div>
			) : null}

			{utilitySkills.length > 0 ? (
				<>
					<div className="px-6 pb-3 pt-8 sm:px-8">
						<span className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
							Utility skills
						</span>
					</div>
					<div className="border-border bg-border grid grid-cols-1 gap-px border-t sm:grid-cols-3">
						{utilitySkills.map((entry) => (
							<SkillCard
								key={entry.id}
								entry={entry}
								tint="muted"
								hoveredSlug={hoveredSlug}
								setHoveredSlug={setHoveredSlug}
							/>
						))}
						<GridFiller count={utilitySkills.length} columns={3} tint="muted" />
					</div>
				</>
			) : null}
		</div>
	)
}

function SkillCard({
	entry,
	tint,
	hoveredSlug,
	setHoveredSlug,
}: {
	entry: SkillEntry
	tint: 'card' | 'muted'
	hoveredSlug: string | null
	setHoveredSlug: (slug: string | null) => void
}) {
	const isActive = hoveredSlug === entry.slug
	// When something elsewhere is hovered, recede the non-matching cards.
	const isDimmed = hoveredSlug !== null && !isActive

	return (
		<Link
			// Skill URLs stay flat at the site root (settled decision).
			href={`/${entry.slug}`}
			data-skill-link
			onMouseEnter={() => setHoveredSlug(entry.slug)}
			onMouseLeave={() => setHoveredSlug(null)}
			onFocus={() => setHoveredSlug(entry.slug)}
			onBlur={() => setHoveredSlug(null)}
			className={cn(
				'focus-visible:ring-ring group relative flex flex-col gap-2 px-6 py-6 transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset sm:px-8',
				tint === 'muted' ? 'bg-muted' : 'bg-background',
				isActive && 'ring-ring ring-2 ring-inset',
				isDimmed ? 'opacity-50' : 'opacity-100',
			)}
		>
			{entry.phase ? (
				<span className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					{entry.phase.label}
				</span>
			) : null}
			<h3 className="text-balance text-lg font-semibold leading-tight tracking-tight sm:text-xl">
				{entry.title}
			</h3>
			{entry.tagline ? (
				<p className="line-clamp-3 text-sm leading-snug opacity-70">
					{entry.tagline}
				</p>
			) : null}
		</Link>
	)
}

/** Pad the trailing row so hairline gaps stay clean (DESIGN.md rule 2). */
function GridFiller({
	count,
	columns,
	tint,
}: {
	count: number
	columns: number
	tint: 'background' | 'muted'
}) {
	const remainder = count % columns
	const fillerCount = remainder === 0 ? 0 : columns - remainder
	if (fillerCount === 0) return null

	return (
		<>
			{Array.from({ length: fillerCount }).map((_, index) => (
				<div
					key={`filler-${index}`}
					aria-hidden="true"
					className={cn(
						'hidden sm:block',
						tint === 'muted' ? 'bg-muted' : 'bg-background',
					)}
				/>
			))}
		</>
	)
}
