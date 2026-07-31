import * as React from 'react'
import Link from 'next/link'
import { TYPE } from '@/components/landing/type'
import { SKILLS_SET_SECTION } from '@/lib/skills-content'
import { invocationName } from '@/components/skills/skill-meta'
import { ArrowRight } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

export type SkillSetItem = {
	slug: string
	title: string
	description?: string
}

export type SkillSetGroup = {
	id: string
	/** Null for skills sitting loose in the list, outside any section. */
	title: string | null
	description?: string
	skills: SkillSetItem[]
}

/**
 * THE SKILL SET (`Skills Page.dc.html` § THE SKILL SET).
 *
 * The catalog, grouped by when you reach for a skill rather than alphabetically
 * or by phase tag. Groups, their order, their one-line descriptions and their
 * members are all the CMS list's `section` resources — nothing here is
 * hardcoded, including the numbering, which is the group's position in the
 * list.
 *
 * ## Why this wears the activity ladder's shape
 *
 * Amy, on the homepage's ladder: *"awesome layout + info design here!"* This is
 * its one named adoption, and it is the right first one for two reasons already
 * on record. It is the same information shape the ladder was designed for — a
 * label and the things under it — so the pattern transfers without being
 * stretched. And `/skills` is a hub-sidebar page, where the standing rule is
 * single-column lists rather than multi-column card grids; the skills catalog
 * was named in that decision as a candidate to follow, and this closes it.
 *
 * So a group is a ladder rung: its name, description and entry point on the
 * left, its skills as a list on the right, one hairline per rung. The rows that
 * used to be bordered cards are plain rows now — the rung's hairline is the
 * structure, and a card inside a ruled row is a box inside a box.
 */
export function SkillSet({ groups }: { groups: SkillSetGroup[] }) {
	if (groups.length === 0) return null

	// Only titled groups are numbered: a loose run has no name to number.
	let groupNumber = 0

	return (
		<section
			aria-labelledby="skill-set-heading"
			className="border-border border-b bg-[color:var(--ah-band)]"
		>
			<div className="px-[18px] pb-[52px] pt-12 sm:px-11">
				{/* Heading, then its line underneath — the shape every other section
				    head on the site uses. This used to push the line to the far right
				    of the row, baseline-aligned with the heading, which works when the
				    heading is a sentence and reads as a stray caption when it is one
				    word. */}
				<div className="mb-[34px] flex flex-col gap-3">
					{/* No eyebrow: "The skill set" over this heading said it twice. And
					    no count in it — see `SKILLS_SET_SECTION`. */}
					<h2 id="skill-set-heading" className={TYPE.heading}>
						{SKILLS_SET_SECTION.heading}
					</h2>
					<p
						className={cn(
							TYPE.lead,
							'max-w-[52ch] text-pretty text-[color:var(--ah-fg-muted)]',
						)}
					>
						{SKILLS_SET_SECTION.lead}
					</p>
				</div>

				{/* The ladder's own container shape: a top rule, and the last rung
				    drops its bottom one so the section closes on whitespace. */}
				{/* Full width of the padded column, no cap. The ladder this copies has
				    none — the gutter is the measure, and a 1000px ceiling left the rows
				    stopping short of the section they sit in. */}
				<ul className="border-border border-t [&>li:last-child]:border-b-0">
					{groups.map((group) => {
						if (group.title) groupNumber += 1
						return (
							<GroupRung
								key={group.id}
								group={group}
								number={group.title ? groupNumber : null}
							/>
						)
					})}
				</ul>
			</div>
		</section>
	)
}

/**
 * One group as a ladder rung, at the exact ratio `ActivityRung` uses
 * (`components/landing/activity-ladder.tsx`). Copying the numbers rather than
 * extracting a shared component is deliberate for now: two adopters is not a
 * pattern, and the ladder's rung carries a question and a "more" link that a
 * skill group does not.
 */
function GroupRung({
	group,
	number,
}: {
	group: SkillSetGroup
	number: number | null
}) {
	// The list's order IS the recommendation — the first skill in a group is its
	// intended entry point, which is why nothing here sorts.
	const startWith = group.skills[0]

	return (
		<li className="border-border grid grid-cols-1 gap-x-12 gap-y-5 border-b py-[30px] md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
			<div className="flex flex-col gap-2.5">
				{group.title ? (
					<h3 className={cn(TYPE.subhead, 'flex items-baseline gap-2.5')}>
						{number !== null ? (
							<span
								aria-hidden
								className={cn(
									TYPE.command,
									'text-[color:var(--ah-fg-faint)]',
								)}
							>
								{String(number).padStart(2, '0')}
							</span>
						) : null}
						{group.title}
					</h3>
				) : null}
				{group.description ? (
					<p
						className={cn(
							TYPE.metaProse,
							'max-w-[46ch] text-pretty text-[color:var(--ah-fg-muted)]',
						)}
					>
						{group.description}
					</p>
				) : null}
				{startWith ? (
					<p className={cn(TYPE.metaMark, 'mt-0.5')}>
						Start with{' '}
						<Link
							href={`/${startWith.slug}`}
							className="text-foreground focus-visible:ring-ring underline decoration-[color:var(--ah-line-strong)] underline-offset-[3px] transition-colors hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
						>
							/{invocationName(startWith.slug)}
						</Link>
					</p>
				) : null}
			</div>

			{/* Dividers come from the rows themselves; the last one drops its rule so
			    the rung ends on whitespace, the same way the activity ladder does. */}
			<ul className="flex flex-col [&>li:last-child_a]:border-b-0">
				{group.skills.map((skill) => (
					<li key={skill.slug}>
						<SkillRow {...skill} />
					</li>
				))}
			</ul>
		</li>
	)
}

function SkillRow({ slug, title, description }: SkillSetItem) {
	return (
		<Link
			href={`/${slug}`}
			className="group border-border hover:bg-muted/60 focus-visible:ring-ring flex items-center gap-4 border-b py-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset md:-mx-4 md:px-4"
		>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span
					className={cn(TYPE.command, 'text-[color:var(--ah-fg-body)] block')}
				>
					/{invocationName(slug)}
				</span>
				<span className={cn(TYPE.bodyTight, 'block text-balance')}>{title}</span>
				{description ? (
					<span
						className={cn(
							TYPE.metaProse,
							'mt-0.5 block text-[color:var(--ah-fg-muted)]',
						)}
					>
						{description}
					</span>
				) : null}
			</span>
			<ArrowRight
				aria-hidden
				className="text-muted-foreground group-hover:text-foreground ease-out-quart size-4 shrink-0 transition-all duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
			/>
		</Link>
	)
}
