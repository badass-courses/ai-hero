import * as React from 'react'
import Link from 'next/link'
import { getListWithSections } from '@/lib/lists-query'
import { SKILLS_LIST_ID } from '@/lib/skills-content'
import { ArrowRight } from 'lucide-react'

/**
 * Homepage skills showcase (wireframe § ⑤).
 *
 * Reads the SAME sectioned list as `/skills` (`SKILLS_LIST_ID` via
 * `getListWithSections`) and renders its named groups. This is deliberate: the
 * homepage previously showed a numbered phase ring while `/skills` showed six
 * named groups, so the same 21 skills had two competing mental models one click
 * apart. The named groups won (Matt's preference, and it is the shape the CMS
 * actually stores) — the phase ring is not used here.
 *
 * The section list is also self-balancing in a way the ring was not: six groups
 * fill a 3-column grid exactly, with no empty cells and no "everything else"
 * bucket sitting where a real step should be.
 *
 * Renders nothing when the list is missing or empty, so the homepage degrades
 * to the sections around it.
 */
export async function SkillsShowcase({
	heading,
	intro,
	ctaHref = '/skills',
	ctaLabel = 'See all skills',
}: {
	heading?: string
	intro?: string
	ctaHref?: string
	ctaLabel?: string
}) {
	const groups = await loadShowcaseGroups()
	if (groups.length === 0) return null

	return (
		<section aria-label="The skills workflow" className="border-b">
			{heading || intro ? (
				<div className="mx-auto flex max-w-3xl flex-col items-center gap-4 px-8 pb-12 text-center sm:px-16">
					{heading ? (
						<h2
										className="text-balance text-3xl font-medium leading-tight tracking-tight sm:text-4xl"
						>
							{heading}
						</h2>
					) : null}
					{intro ? (
						<p className="max-w-[62ch] text-balance text-base leading-relaxed opacity-80 sm:text-lg">
							{intro}
						</p>
					) : null}
				</div>
			) : null}

			{/* Numerals carry the structure, not rules. A deliberate departure from
			    DESIGN.md rule 2: at six cells the per-cell hairlines chopped one
			    workflow into six unrelated boxes. The numerals give every cell the
			    same optical anchor, so unequal skill counts (2 to 6) stop reading as
			    ragged, and the section keeps its outer border so it still sits in
			    the page's system. */}
			<div className="grid grid-cols-1 gap-x-10 gap-y-12 px-8 sm:grid-cols-2 sm:px-16 lg:grid-cols-3">
				{groups.map((group, i) => (
					<div key={group.id} className="flex flex-col gap-3">
						<div className="flex items-baseline gap-3">
							<span
								aria-hidden
								className="text-foreground/25 font-mono text-3xl font-medium leading-none tabular-nums"
							>
								{String(i + 1).padStart(2, '0')}
							</span>
							<h3 className="text-balance text-xl font-semibold leading-tight tracking-tight">
								{group.title}
							</h3>
						</div>
						{group.description ? (
							<p className="text-muted-foreground max-w-[38ch] text-balance pl-[calc(2ch+0.75rem)] text-sm leading-relaxed">
								{group.description}
							</p>
						) : null}
						{/* Pills, not bare mono text: these are the only links in the block
						    and the entire point of it. Wrapping is also what equalises
						    cells with very different skill counts. */}
						<ul className="flex flex-wrap gap-2 pl-[calc(2ch+0.75rem)] pt-1">
							{group.skills.map((skill) => (
								<li key={skill.slug}>
									<Link
										href={`/${skill.slug}`}
										className="border-border bg-muted/40 text-foreground/90 hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:ring-ring inline-flex items-center rounded-full border px-3 py-1.5 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
									>
										{skill.command}
									</Link>
								</li>
							))}
						</ul>
					</div>
				))}
			</div>

			{/* Centered under the grid, matching the centered headline above. It used
			    to sit alone in a bordered strip at the bottom left, which read as a
			    leftover rather than the section's exit. */}
			<div className="flex justify-center px-8 pb-16 pt-14 sm:px-16">
				<Link
					href={ctaHref}
					className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring group inline-flex h-12 items-center gap-2 rounded-full px-7 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
				>
					{ctaLabel}
					<ArrowRight
						aria-hidden
						className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none"
					/>
				</Link>
			</div>
		</section>
	)
}

type ShowcaseGroup = {
	id: string
	title: string
	description?: string
	skills: { slug: string; title: string; command: string }[]
}

/**
 * Same walk `/skills` does: `section` resources become titled groups of their
 * published + public children. Loose (unsectioned) skills are skipped here —
 * on the homepage they would reintroduce the "everything else" bucket this
 * component exists to remove. `/skills` still shows them.
 */
async function loadShowcaseGroups(): Promise<ShowcaseGroup[]> {
	const list = await getListWithSections(SKILLS_LIST_ID)
	const groups: ShowcaseGroup[] = []

	for (const item of list?.resources ?? []) {
		const resource = item.resource as any
		if (resource?.type !== 'section') continue

		const skills = (resource.resources ?? [])
			.map((child: any) => child?.resource)
			.filter(
				(child: any) =>
					child?.fields?.state === 'published' &&
					child?.fields?.visibility === 'public' &&
					typeof child?.fields?.slug === 'string',
			)
			.map((child: any) => ({
				slug: child.fields.slug as string,
				title: String(child.fields.title ?? ''),
				command: commandFor(child.fields.slug as string),
			}))

		if (skills.length === 0) continue

		const title = resource.fields?.title
		const description = resource.fields?.description
		groups.push({
			id: resource.id ?? String(title),
			title: typeof title === 'string' && title ? title : 'Skills',
			description:
				typeof description === 'string' && description ? description : undefined,
			skills,
		})
	}

	return groups
}

/**
 * Slash-command form of a skill slug: `skills-grill-me` reads as `/grill-me`.
 * Every skill title starts "The /… Skill", so rendering the raw title 21 times
 * puts the same five characters at the start of every line and destroys
 * scanning. The command IS the recognizable token.
 */
function commandFor(slug: string): string {
	return `/${slug.replace(/^skills-/, '')}`
}
