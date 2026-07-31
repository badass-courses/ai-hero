import * as React from 'react'
import Link from 'next/link'
import { getListWithSections } from '@/lib/lists-query'
import { SKILLS_LIST_ID } from '@/lib/skills-content'
import { ArrowRight } from 'lucide-react'

import { SectionHeader } from './section-header'

import { TYPE } from './type'

import { cn } from '@coursebuilder/utils/cn'

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
 *
 * ## Card order is CMS data, not a constant here
 *
 * The prototype leads with "01 The Main Flow"; this renders "01 Getting
 * Started" because that is the order the CMS stores. The numeral and the
 * accent are positional — index 0 of `groups` — and `groups` is the list's own
 * order, so nothing in this file can or should reorder them.
 *
 * Verified 2026-07-28 against the database (read-only): the order is
 * `AI_ContentResourceResource.position` for `resourceOfId = 'list_ppwir'`
 * (`SKILLS_LIST_ID`), which today reads 0 Getting Started, 1 The Main Flow,
 * 2 Shaping, 3 Upkeep, 4 Non-Coding Skills, 5 Reference Skills. Phase tags
 * (`skills-query.ts`, `popularity_order` / `phase-N`) are NOT involved — they
 * were superseded as the grouping mechanism on 2026-07-14 and are additive
 * badge metadata only.
 *
 * To match the prototype, two CMS edits are needed, both on the skills list:
 *
 * 1. Swap positions 0 and 1 so The Main Flow leads. This also reorders
 *    `/skills`, which reads the same list — that is the point, the two
 *    surfaces are meant to agree.
 * 2. Give The Main Flow the prototype's description: "The idea → ship arc, in
 *    order. If you only take one thing, take this." The second sentence is
 *    what makes the lead card a recommendation rather than just the first
 *    item; it is stored on the `section` resource's `fields.description`.
 */
export async function SkillsShowcase({
	heading,
	intro,
	ctaHref = '/skills',
	ctaLabel,
}: {
	heading?: string
	intro?: string
	ctaHref?: string
	ctaLabel?: string
}) {
	const { groups, totalSkillCount } = await loadShowcaseGroups()
	if (groups.length === 0) return null

	// Counted, never typed. The prototype's "See all 31 skills" is the shape,
	// and the number is the count at the DESTINATION — /skills renders the loose
	// skills this grid deliberately omits, so counting only what the grid shows
	// sent the reader to a page with more skills than the link promised.
	const resolvedCtaLabel = ctaLabel ?? `See all ${totalSkillCount} skills`

	return (
		<section
			aria-label="The skills workflow"
			className="border-b bg-[color:var(--ah-band)]"
		>
			{/* Amy, on "THE SYSTEM · FREE AND OPEN SOURCE": "let's only use these
			    mini headlines when they make sense. here, 'the system' is redundant.
			    let's add an 'open source' badge below the headline instead. and let
			    the headline be the first thing."

			    The eyebrow is gone and the headline leads. The badge is gone too: the
			    intro's first six words are "Every skill here is free", so the badge
			    was the same fact said twice, a line apart, and the second telling was
			    the one wearing accent ink. The mark it replaced is what Amy wanted
			    removed; the sentence had already absorbed the fact. */}
			{heading || intro ? (
				<SectionHeader
					heading={heading}
					rank="lead"
					// Sits on the heading's baseline rather than trailing the rows:
					// the reader learns where the section goes before deciding to
					// read it, and the page keeps one primary (gold) action.
					linkHref={ctaHref}
					linkLabel={resolvedCtaLabel}
				>
					{intro}
				</SectionHeader>
			) : null}

			{/* A grid after all. The earlier objection to one — counts running 2 to
			    6 make wildly unequal boxes — does not hold once the cells are
			    hairline grid children: they stretch to their row's height for free,
			    and pinning the CTA with `mt-auto` lands every button on the same
			    baseline across a row. Six groups fill three columns exactly; the
			    filler cells keep the trailing line clean if that ever changes
			    (DESIGN rule 2).

			    Inset in the gutter and given a radius, rather than bled to the
			    container's edge: this is a panel of six things sitting ON the
			    band, which is what the band is for. Full-bleed it read as six
			    more page sections stacked sideways. */}
			<div className="px-[18px] pb-14 sm:px-11 sm:pb-20 md:pt-[12px]">
			<ul className="border-border bg-border grid grid-cols-1 gap-px overflow-hidden rounded-lg border sm:grid-cols-2 lg:grid-cols-3">
				{groups.map((group, index) => (
					<li
						key={group.id}
						className="bg-background flex flex-col px-6 pb-[22px] pt-[26px]"
					>
						<div className="mb-[18px] flex flex-col gap-2">
							{/* The numeral says these groups are a sequence rather than a
							    menu, and that the first one is where the sequence starts —
							    the only cell in the grid that earns the accent. */}
							<h3
								className={cn(
									TYPE.subhead,
									'flex items-baseline gap-2.5 text-balance',
								)}
							>
								<span
									aria-hidden
									className={cn(
										TYPE.command,
										index === 0
											? 'text-primary'
											: 'text-[color:var(--ah-fg-faint)]',
									)}
								>
									{String(index + 1).padStart(2, '0')}
								</span>
								{group.title}
							</h3>
							{group.description ? (
								<p className={cn(TYPE.metaProse, 'text-muted-foreground text-balance')}>
									{group.description}
								</p>
							) : null}
						</div>

						{/* Chips, not bare mono text: these are the only links in the
						    block and the entire point of it. */}
						<ul className="mb-5 flex flex-wrap gap-1.5">
							{group.skills.map((skill) => (
								<li key={skill.slug}>
									<Link
										href={`/${skill.slug}`}
										// `.cmd` in the prototype: 12px mono on a 5.5%-ink wash,
										// a 9%-ink edge, 6px radius, 6×9 padding. Quiet at rest
										// because a card can carry six of them; the invert on
										// hover/focus is what makes them read as links.
										className={cn(TYPE.command, 'border-border bg-foreground/[0.055] text-[color:var(--ah-fg-body)] hover:border-foreground hover:bg-foreground hover:text-background focus-visible:ring-ring inline-flex items-center whitespace-nowrap rounded-sm border px-[9px] py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2')}
									>
										{skill.command}
									</Link>
								</li>
							))}
						</ul>

						{/* One obvious way in per group. A wall of equal-weight pills
						    gives a reader no idea which to try first, and the list is
						    ordered — the CMS position of the first skill IS the intended
						    entry point.

						    Full width, not hugging its label: `mt-auto` already bottom
						    aligns them, and equal width stops the longest command
						    (`/improve-codebase-architecture`) wrapping to two lines while
						    its neighbours sit on one.

						    Neutral in five of six cells. Colouring all six made the block
						    shout louder than the section header above it; colouring none
						    left six equal doors and no recommendation. The first group is
						    the main flow, so it alone carries the accent. */}
						{group.skills[0] ? (
							<Link
								href={`/${group.skills[0].slug}`}
								className={cn(
									TYPE.command,
									'focus-visible:ring-ring group mt-auto flex w-full items-center justify-between gap-2.5 rounded-[8px] border px-[13px] py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
									index === 0
										? // The one entry point the section actually recommends.
											'border-primary/35 bg-primary/[0.07] text-primary hover:bg-primary/15'
										: 'border-border text-[color:var(--ah-fg-body)] hover:bg-muted hover:text-foreground',
								)}
							>
								{/* Mono all the way through, label included. The prototype
								    sets the whole row in `.cmd`'s family, and mixing sans
								    "Start with" against a mono command made the command look
								    like an inline code span dropped into a sentence rather
								    than the button's subject. */}
								<span className="truncate">
									Start with {group.skills[0].command}
								</span>
								<ArrowRight
									aria-hidden
									className="ease-out-quart size-3.5 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
								/>
							</Link>
						) : null}
					</li>
				))}
				{Array.from({ length: fillerCount(groups.length) }).map((_, i) => (
					<li
						key={`filler-${i}`}
						aria-hidden
						className="bg-background hidden lg:block"
					/>
				))}
			</ul>
			</div>
		</section>
	)
}

/** Empty cells to keep the trailing hairline clean at 3 across. */
function fillerCount(count: number): number {
	const remainder = count % 3
	return remainder === 0 ? 0 : 3 - remainder
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
async function loadShowcaseGroups(): Promise<{
	groups: ShowcaseGroup[]
	/**
	 * Every published + public skill in the list, LOOSE ONES INCLUDED — which
	 * is more than the grid renders. The CTA says "See all N skills" and points
	 * at /skills, so the number describes the DESTINATION, not the grid; counting
	 * only the sectioned skills advertised a figure lower than what the reader
	 * then found there.
	 */
	totalSkillCount: number
}> {
	const list = await getListWithSections(SKILLS_LIST_ID)
	const groups: ShowcaseGroup[] = []
	let totalSkillCount = 0

	const isPublicSkill = (child: any) =>
		child?.fields?.state === 'published' &&
		child?.fields?.visibility === 'public' &&
		typeof child?.fields?.slug === 'string'

	for (const item of list?.resources ?? []) {
		const resource = item.resource as any
		if (resource?.type !== 'section') {
			// A loose skill: counted, not rendered.
			if (isPublicSkill(resource)) totalSkillCount++
			continue
		}

		const skills = (resource.resources ?? [])
			.map((child: any) => child?.resource)
			.filter(isPublicSkill)
			.map((child: any) => ({
				slug: child.fields.slug as string,
				title: String(child.fields.title ?? ''),
				command: commandFor(child.fields.slug as string),
			}))

		totalSkillCount += skills.length
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

	return { groups, totalSkillCount }
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
