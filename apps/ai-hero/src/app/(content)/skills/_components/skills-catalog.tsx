/**
 * Skill catalog grid for the /skills landing. A plain, browsable grid of skill
 * cards (title, tagline, phase badge) in cycle order, plus a distinct-tint
 * utility row. Every card is a flat `/{slug}` link.
 *
 * Deliberately simple (2026-07-06): the interactive SkillCycle diagram + the
 * cycle↔catalog hover-sync were removed from /skills for now — they read as
 * broken (shared hover across sections, duplicated skills). This is the "fine
 * but not broken" version; the diagram/hover work is parked for a later pass
 * (the `SkillCycle` component still lives in `src/components/skills`).
 */

import Link from 'next/link'
import { type SkillEntry } from '@/lib/skills-shared'

import { cn } from '@coursebuilder/utils/cn'

export function SkillsCatalog({
	skills,
	utilitySkills,
}: {
	/** Core skill entries in cycle order (position order). */
	skills: SkillEntry[]
	/** Utility skills for the distinct-tint row. */
	utilitySkills: SkillEntry[]
}) {
	if (skills.length === 0 && utilitySkills.length === 0) return null

	return (
		<div>
			{skills.length > 0 ? (
				<div className="border-border bg-border grid grid-cols-1 gap-px border-b sm:grid-cols-2 lg:grid-cols-3">
					{skills.map((entry) => (
						<SkillCard key={entry.id} entry={entry} tint="background" />
					))}
					<GridFiller count={skills.length} columns={3} tint="background" />
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
							<SkillCard key={entry.id} entry={entry} tint="muted" />
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
}: {
	entry: SkillEntry
	tint: 'background' | 'muted'
}) {
	return (
		<Link
			// Skill URLs stay flat at the site root (settled decision).
			href={`/${entry.slug}`}
			className={cn(
				'focus-visible:ring-ring group relative flex flex-col gap-2 px-6 py-6 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset sm:px-8',
				tint === 'muted' ? 'bg-muted hover:bg-muted/70' : 'bg-background hover:bg-muted',
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
