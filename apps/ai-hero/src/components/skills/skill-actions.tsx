import * as React from 'react'
import Link from 'next/link'
import { TYPE } from '@/components/landing/type'
import {
	SKILLS_FREE_LESSON,
	SKILLS_SH_BADGE_URL,
	SKILLS_SH_URL,
} from '@/lib/skills-content'
import { type SkillEntry } from '@/lib/skills-shared'
import { ArrowLeft, ArrowRight } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

import { CompleteOnNavigateLink } from '@/components/complete-on-navigate-link'

import { SkillInstallTabs } from './skill-install-tabs'
import { invocationName } from './skill-meta'

/**
 * "Skill actions" — the band between a skill's body and its related reading
 * (redesign README §6). Three things a reader wants the moment they finish
 * reading: install the whole set, watch it used on something real, and step to
 * the neighbouring skill.
 *
 * The head panel installs THIS skill; this one installs the set. Both lines are
 * on the page on purpose — a reader who has just read one skill is the reader
 * most likely to want the rest.
 *
 * The set is offered as TABS rather than as one command, mirroring what
 * `/skills` now shows: the portable installer that works with any agent, and
 * the Claude Code plugin. Stacked they are a wall inside an article; tabbed,
 * the default is true for everyone and the plugin is one click away for the
 * readers it applies to. See `SkillInstallTabs`.
 */
export function SkillActions({
	slug,
	prev,
	current,
	next,
	showFreeLesson = true,
	className,
}: {
	/** The skill post's flat root slug. */
	slug: string
	/** Cycle neighbours. Omit the whole trio when the post is not a list member. */
	prev?: SkillEntry | null
	current?: SkillEntry | null
	next?: SkillEntry | null
	/**
	 * Whether to offer the free email course here.
	 *
	 * False when the BODY already asked for it, which on a skill post is the
	 * default: `resolvePostCta` gives every skill `kind: 'course'` unless the CMS
	 * says otherwise. The page was making the same offer twice, a screen apart —
	 * "Start the free course" above, "Take the free lesson" below, both landing
	 * on /skills/subscribe. The same rule already suppresses the closing
	 * newsletter for the same reason; this cell was simply never brought under
	 * it.
	 *
	 * Deduping HERE rather than gating on the reader is deliberate. The body CTA
	 * is the better of the two — it knows who is reading and says "you're already
	 * subscribed, one click starts the course" — so the fix is to stop competing
	 * with it, not to hide this cell from subscribers and leave two asks for
	 * everyone else.
	 */
	showFreeLesson?: boolean
	className?: string
}) {
	const command = invocationName(slug)
	const hasPager = Boolean(prev && current && next)

	return (
		<section
			id="skill-actions"
			aria-label="Skill actions"
			data-toc-cta="skill"
			data-toc-label="Install the skill"
			className={cn('bg-muted scroll-mt-(--nav-height)', className)}
		>
			<div className="px-5 py-10 sm:px-11 sm:py-11">
				<p className={cn(TYPE.groupLabel, 'mb-5')}>
					Skill actions
				</p>

				{/* Hairline grid: the 1px gaps ARE the dividers (DESIGN rule 2).
				    `auto-fit` rather than a written-down two-column track, because
				    the free-lesson cell may not be here: with a fixed template the
				    install cell kept its 1.25fr and left the rest of the band empty.
				    auto-fit collapses the unused track, so one cell takes the row. */}
				<div className="border-border bg-border grid gap-px overflow-hidden rounded-lg border min-[901px]:grid-cols-[repeat(auto-fit,minmax(320px,1fr))]">
					<div className="bg-background px-6 py-6 sm:py-7">
						{/* Heading left, live proof right, on one baseline. The count
						    belongs beside the ask rather than above or below it: a
						    reader deciding whether to run the command is the only
						    reader it is an argument for, and on its own line it read as
						    a stray graphic. */}
						<div className="mb-3.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
							{/* "Add this skill" was the old heading, and it was wrong
							    twice over: this command installs the whole set, and
							    installing THIS skill is what the head panel at the top of
							    the page already offers.

							    "Install the skills" is the same phrase `/skills` uses
							    over the same two commands, which is the point — a reader
							    meeting this band after an article should recognise it,
							    not read it as a third thing to do. */}
							<h2 className={TYPE.subhead}>Install the skills</h2>
							<Link
								href={SKILLS_SH_URL}
								target="_blank"
								rel="noreferrer"
								className="focus-visible:ring-ring inline-flex flex-none rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
							>
								{/* Skills.sh's own live, five-minute-cached aggregate badge.
								    A plain img is deliberate, same as the hero: Next's image
								    optimization would cache a second copy and make the
								    number less live, which is the only reason it is here. */}
								{/* eslint-disable-next-line @next/next/no-img-element */}
								<img
									src={SKILLS_SH_BADGE_URL}
									alt="Live Skills.sh install count"
									width={101}
									height={20}
								/>
							</Link>
						</div>
						<SkillInstallTabs command={command} />
					</div>

					{showFreeLesson ? (
					<div className="bg-card flex flex-col px-6 py-6 sm:py-7">
						<h2 className={cn(TYPE.subhead, 'mb-2')}>
							See it on a real project
						</h2>
						<p
							className={cn(
								TYPE.metaProse,
								'mb-5 text-[color:var(--ah-fg-muted)]',
							)}
						>
							{SKILLS_FREE_LESSON.description}
						</p>
						<Link
							href={SKILLS_FREE_LESSON.href}
							className={cn(
								TYPE.meta,
								'bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring group mt-auto inline-flex w-fit items-center gap-2 self-start rounded-[9px] px-[18px] py-3 font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
							)}
						>
							{SKILLS_FREE_LESSON.label}
							<ArrowRight
								aria-hidden
								className="ease-out-quart size-4 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
							/>
						</Link>
					</div>
					) : null}
				</div>

				{hasPager ? (
					<SkillPager prev={prev!} current={current!} next={next!} />
				) : null}
			</div>
		</section>
	)
}

/**
 * Previous / you-are-here / next. Below 901px the middle card is dropped and
 * the two neighbours split the row (spec `.ah-pager`) — a reader on a phone has
 * the title an inch above their thumb and does not need a card to tell them
 * where they are. The survivors shrink to the bare command name, which is the
 * only part of "The /grill-me Skill" that survives a half-width column anyway.
 */
function SkillPager({
	prev,
	current,
	next,
}: {
	prev: SkillEntry
	current: SkillEntry
	next: SkillEntry
}) {
	return (
		<nav
			aria-label="Skill cycle"
			className="mt-4 flex gap-2.5 min-[901px]:grid min-[901px]:grid-cols-3"
		>
			<PagerCard entry={prev} role="Previous skill" direction="prev" />
			<PagerCard entry={current} role="You are here" isCurrent />
			{/* Next carries the completion write: this pager REPLACES the lesson
			    pager on skill pages, and stepping forward is the page's one "done
			    here" gesture. Previous does not — going back says nothing about
			    having finished. */}
			<PagerCard
				entry={next}
				role="Next skill"
				direction="next"
				completesResourceId={current.id}
			/>
		</nav>
	)
}

function PagerCard({
	entry,
	role,
	isCurrent = false,
	direction,
	completesResourceId,
}: {
	entry: SkillEntry
	role: string
	isCurrent?: boolean
	direction?: 'prev' | 'next'
	/** Navigating this card marks the given resource (the current post) complete. */
	completesResourceId?: string
}) {
	// Lucide, not `←`/`→`: the characters render at the title's own weight and
	// metrics, so they sat heavier and lower than every other arrow on the page.
	// Laid out as a flex row so the glyph is optically centred against the text
	// rather than riding the baseline, and pinned to the card's outer edge —
	// previous on the left, next on the right — so the pair reads as a spread.
	const label = (
		<span className="flex min-w-0 items-center gap-1.5">
			{direction === 'prev' ? (
				<ArrowLeft aria-hidden className="size-4 shrink-0" />
			) : null}
			{/* Two renderings of the same name, not two names: the half-width mobile
			    card can only carry the command. */}
			<span className={cn(TYPE.command, 'truncate min-[901px]:hidden')}>
				/{invocationName(entry.slug)}
			</span>
			<span className="hidden truncate min-[901px]:inline">{entry.title}</span>
			{direction === 'next' ? (
				<ArrowRight aria-hidden className="ml-auto size-4 shrink-0" />
			) : null}
		</span>
	)

	if (isCurrent) {
		return (
			<div
				aria-current="page"
				className="hidden rounded-md border border-[color:var(--ah-accent-line)] bg-[color:var(--ah-accent-wash)] px-[18px] py-4 min-[901px]:block"
			>
				<p className={cn(TYPE.groupLabel, 'text-primary mb-2.5')}>{role}</p>
				<p className={cn(TYPE.cardTitle, 'text-foreground')}>{label}</p>
			</div>
		)
	}

	return (
		<CompleteOnNavigateLink
			href={`/${entry.slug}`}
			completesResourceId={completesResourceId}
			className="border-border bg-background hover:border-foreground/30 focus-visible:ring-ring group min-w-0 flex-1 rounded-md border px-[18px] py-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
		>
			<p className={cn(TYPE.groupLabel, 'mb-2.5')}>{role}</p>
			<p
				className={cn(
					TYPE.cardTitle,
					'group-hover:text-foreground truncate font-medium text-[color:var(--ah-fg-muted)] transition-colors',
				)}
			>
				{label}
			</p>
		</CompleteOnNavigateLink>
	)
}
