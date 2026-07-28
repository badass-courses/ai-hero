import * as React from 'react'
import Link from 'next/link'
import { getListWithSections } from '@/lib/lists-query'
import { SKILLS_LIST_ID } from '@/lib/skills-content'

import { SectionHeader } from './section-header'

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
				<SectionHeader
					heading={heading}
					// Sits on the heading's baseline rather than trailing the rows:
					// the reader learns where the section goes before deciding to
					// read it, and the page keeps one primary (gold) action.
					linkHref={ctaHref}
					linkLabel={ctaLabel}
				>
					{intro}
				</SectionHeader>
			) : null}

			{/* Rows, not a 3-up grid. Six groups with skill counts running 2 to 6
			    made a grid of wildly unequal boxes with ragged bottoms; as full
			    width rows the numerals form a left rail, every title sits on the
			    same x, and the block reads as the ordered workflow it describes.
			    Hairlines between rows, which is a list (the site's own language),
			    not six boxes. */}
			<ul className="border-border bg-border flex flex-col gap-px border-y">
				{groups.map((group) => (
					<li
						key={group.id}
						className="bg-background grid grid-cols-1 gap-x-8 gap-y-4 px-8 py-8 sm:px-16 md:grid-cols-[auto_minmax(0,20rem)_minmax(0,1fr)] md:items-baseline"
					>
						{/* The count, not an index. These groups are named buckets,
						    not a numbered process — "Reference Skills" is not step 6 of
						    anything — so an ordinal asserts a sequence the content does
						    not have. The count is the one number a reader actually wants
						    here, and the rail keeps its numeral. */}
						<p className="flex items-baseline gap-1.5 md:w-16 md:flex-col md:gap-0">
							<span className="text-foreground/40 font-mono text-2xl font-medium leading-none tabular-nums">
								{group.skills.length}
							</span>
							<span className="text-muted-foreground font-mono text-[11px] uppercase tracking-wider">
								{group.skills.length === 1 ? 'skill' : 'skills'}
							</span>
						</p>
						<div className="flex flex-col gap-1.5">
							<h3 className="text-balance text-xl font-semibold leading-tight tracking-tight">
								{group.title}
							</h3>
							{group.description ? (
								<p className="text-muted-foreground text-balance text-sm leading-relaxed">
									{group.description}
								</p>
							) : null}
						</div>
						{/* Pills, not bare mono text: these are the only links in the
						    block and the entire point of it. */}
						<ul className="flex flex-wrap gap-2">
							{group.skills.map((skill) => (
								<li key={skill.slug}>
									<Link
										href={`/${skill.slug}`}
										// These are the most important links in the section, so
										// they get a link's affordance rather than a chip's: full
										// contrast text, a visible edge, and an unambiguous
										// invert on hover/focus (the site's badge treatment).
										className="border-foreground/20 bg-muted text-foreground hover:border-foreground hover:bg-foreground hover:text-background focus-visible:ring-ring inline-flex items-center rounded-full border px-3.5 py-1.5 font-mono text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
									>
										{skill.command}
									</Link>
								</li>
							))}
						</ul>
					</li>
				))}
			</ul>

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
