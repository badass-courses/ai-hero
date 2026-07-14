/**
 * Skill catalog for the /skills landing, grouped by the CMS list's `section`
 * resources (decided 2026-07-14 — sections drive the grouping; supersedes the
 * phase-tag core/utility split). Each group renders a heading (section title +
 * optional description) above a hairline grid of skill cards (title, tagline,
 * phase badge); loose skills outside any section render as a bare grid. Every
 * card is a flat `/{slug}` link.
 *
 * Deliberately simple (2026-07-06): the interactive SkillCycle diagram + the
 * cycle↔catalog hover-sync were removed from /skills for now — they read as
 * broken (shared hover across sections, duplicated skills). This is the "fine
 * but not broken" version; the diagram/hover work is parked for a later pass
 * (the `SkillCycle` component still lives in `src/components/skills`).
 */

import Link from 'next/link'
import { type SkillCatalogGroup, type SkillEntry } from '@/lib/skills-shared'

export function SkillsCatalog({ groups }: { groups: SkillCatalogGroup[] }) {
	const nonEmpty = groups.filter((group) => group.skills.length > 0)
	if (nonEmpty.length === 0) return null

	return (
		<div>
			{nonEmpty.map((group) => (
				<section key={group.id}>
					{group.title ? (
						<div className="px-6 pb-4 pt-10 sm:px-8">
							<h3 className="text-foreground text-2xl font-semibold tracking-tight sm:text-3xl">
								{group.title}
							</h3>
							{group.description ? (
								<p className="text-foreground/60 mt-2 max-w-2xl text-balance text-sm leading-relaxed sm:text-base">
									{group.description}
								</p>
							) : null}
						</div>
					) : null}
					<div className="border-border bg-border grid grid-cols-1 gap-px border-y sm:grid-cols-2 lg:grid-cols-3">
						{group.skills.map((entry) => (
							<SkillCard key={entry.id} entry={entry} />
						))}
						<GridFiller count={group.skills.length} columns={3} />
					</div>
				</section>
			))}
		</div>
	)
}

function SkillCard({ entry }: { entry: SkillEntry }) {
	return (
		<Link
			// Skill URLs stay flat at the site root (settled decision).
			href={`/${entry.slug}`}
			className="focus-visible:ring-ring bg-background hover:bg-muted group relative flex flex-col gap-2 px-6 py-6 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset sm:px-8"
		>
			{entry.phase ? (
				<span className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					{entry.phase.label}
				</span>
			) : null}
			<h4 className="text-balance text-lg font-semibold leading-tight tracking-tight sm:text-xl">
				{entry.title}
			</h4>
			{entry.tagline ? (
				<p className="line-clamp-3 text-sm leading-snug opacity-70">
					{entry.tagline}
				</p>
			) : null}
		</Link>
	)
}

/** Pad the trailing row so hairline gaps stay clean (DESIGN.md rule 2). */
function GridFiller({ count, columns }: { count: number; columns: number }) {
	const remainder = count % columns
	const fillerCount = remainder === 0 ? 0 : columns - remainder
	if (fillerCount === 0) return null

	return (
		<>
			{Array.from({ length: fillerCount }).map((_, index) => (
				<div
					key={`filler-${index}`}
					aria-hidden="true"
					className="bg-background hidden sm:block"
				/>
			))}
		</>
	)
}
