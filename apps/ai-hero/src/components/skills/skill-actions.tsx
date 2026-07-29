import * as React from 'react'
import Link from 'next/link'
import { InstallCommand } from '@/app/(content)/skills/_components/install-command'
import { TYPE } from '@/components/landing/type'
import { SKILLS_FREE_LESSON } from '@/lib/skills-content'
import { type SkillEntry } from '@/lib/skills-shared'
import { ArrowLeft, ArrowRight } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

import { SKILLS_INSTALL_ALL_COMMAND, invocationName } from './skill-meta'

/**
 * "Skill actions" — the band between a skill's body and its related reading
 * (redesign README §6). Three things a reader wants the moment they finish
 * reading: install the whole set, watch it used on something real, and step to
 * the neighbouring skill.
 *
 * The head panel installs THIS skill; this one installs the set. Both lines are
 * on the page on purpose — a reader who has just read one skill is the reader
 * most likely to want the rest.
 */
export function SkillActions({
	slug,
	prev,
	current,
	next,
	className,
}: {
	/** The skill post's flat root slug. */
	slug: string
	/** Cycle neighbours. Omit the whole trio when the post is not a list member. */
	prev?: SkillEntry | null
	current?: SkillEntry | null
	next?: SkillEntry | null
	className?: string
}) {
	const command = invocationName(slug)
	const hasPager = Boolean(prev && current && next)

	return (
		<section
			aria-label="Skill actions"
			className={cn('bg-muted', className)}
		>
			<div className="px-5 py-10 sm:px-11 sm:py-11">
				<p className={cn(TYPE.micro, 'mb-5 text-[color:var(--ah-fg-label)]')}>
					Skill actions
				</p>

				{/* Hairline grid: the 1px gaps ARE the dividers (DESIGN rule 2). */}
				<div className="border-border bg-border grid gap-px overflow-hidden rounded-lg border min-[901px]:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
					<div className="bg-background px-6 py-6 sm:py-7">
						<h2 className={cn(TYPE.subhead, 'mb-3.5')}>Add this skill</h2>
						<InstallCommand
							command={SKILLS_INSTALL_ALL_COMMAND}
							label="Install command for every skill"
						/>
						<p
							className={cn(
								TYPE.metaProse,
								'mt-3 text-[color:var(--ah-fg-muted)]',
							)}
						>
							Installs the whole set. Then type{' '}
							<code
								className={cn(
									TYPE.command,
									'text-foreground bg-foreground/[0.055] border-border/70 rounded-[4px] border px-1.5 py-0.5',
								)}
							>
								/{command}
							</code>{' '}
							in your coding agent.
						</p>
					</div>

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
			<PagerCard entry={next} role="Next skill" direction="next" />
		</nav>
	)
}

function PagerCard({
	entry,
	role,
	isCurrent = false,
	direction,
}: {
	entry: SkillEntry
	role: string
	isCurrent?: boolean
	direction?: 'prev' | 'next'
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
				<p className={cn(TYPE.micro, 'text-primary mb-2.5')}>{role}</p>
				<p className={cn(TYPE.cardTitle, 'text-foreground')}>{label}</p>
			</div>
		)
	}

	return (
		<Link
			href={`/${entry.slug}`}
			className="border-border bg-background hover:border-foreground/30 focus-visible:ring-ring group min-w-0 flex-1 rounded-md border px-[18px] py-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
		>
			<p className={cn(TYPE.micro, 'mb-2.5 text-[color:var(--ah-fg-label)]')}>
				{role}
			</p>
			<p
				className={cn(
					TYPE.cardTitle,
					'group-hover:text-foreground truncate font-medium text-[color:var(--ah-fg-muted)] transition-colors',
				)}
			>
				{label}
			</p>
		</Link>
	)
}
