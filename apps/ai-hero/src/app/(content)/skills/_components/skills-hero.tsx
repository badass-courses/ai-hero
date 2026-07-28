import * as React from 'react'
import Link from 'next/link'
import { TYPE } from '@/components/landing/type'
import { getRepoStarCount } from '@/lib/github-stars-query'
import { SKILLS_COURSE_PANEL, SKILLS_HERO } from '@/lib/skills-content'
import { ArrowRight, Star } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

import { InstallCommand } from './install-command'

/**
 * The page's HEAD (`Skills Page.dc.html` § HEAD).
 *
 * Pitch left, the free course right, one hairline between them — the same
 * shape as the flagship hero on /courses, and for the same reason: the page
 * makes one argument and takes one ask, and the ask does not get wider just
 * because the window did (`minmax(0,1fr) 400px`).
 *
 * Everything numeric here is live. The eyebrow's skill count and the version
 * come from the CMS (the list's members, and the newest changelog entry's
 * `vX.Y` prefix); the star count comes from GitHub. A missing value drops its
 * stat rather than printing a placeholder.
 */
export async function SkillsHero({
	stars: starsProp,
	skillCount,
	latestVersion,
}: {
	/**
	 * GitHub star count, consolidated at the page level (spec §7). When omitted
	 * the component fetches it itself so standalone usage still works.
	 */
	stars?: number | null
	/** Live count of published skills in the CMS list. */
	skillCount?: number
	/** e.g. "v1.1", parsed off the newest changelog entry. Null drops the stat. */
	latestVersion?: string | null
} = {}) {
	const stars =
		starsProp !== undefined
			? starsProp
			: await getRepoStarCount(SKILLS_HERO.repoOwner, SKILLS_HERO.repoName)

	return (
		<header
			id="skills-hero"
			className="border-border grid grid-cols-1 items-stretch border-b lg:grid-cols-[minmax(0,1fr)_400px]"
		>
			<div className="px-8 pb-11 pt-12 sm:px-11">
				<p className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}>
					{['Free', 'open source', skillCount ? `${skillCount} skills` : null]
						.filter(Boolean)
						.join(' · ')}
				</p>
				<h1
					className={cn(TYPE.title, 'mb-4 mt-[18px] max-w-[22ch] text-balance')}
				>
					{SKILLS_HERO.title}
				</h1>
				<p
					className={cn(
						TYPE.lead,
						'mb-[26px] max-w-[52ch] text-pretty text-[color:var(--ah-fg-muted)]',
					)}
				>
					{SKILLS_HERO.tagline} {SKILLS_HERO.taglineTail}
				</p>
				<InstallCommand
					command={SKILLS_HERO.installCommand}
					className="max-w-[560px]"
				/>
				{/* The three facts a reader checks before running anything: how many
				    other people trust it, how current it is, and whether it works
				    where they already are. On a hairline, not in boxes. */}
				<dl className="border-border mt-[26px] flex flex-wrap gap-x-[26px] gap-y-6 border-t pt-[22px]">
					{stars !== null ? (
						<Fact label="GitHub stars">
							<span className="flex items-center gap-[7px]">
								<Star
									aria-hidden
									className="text-primary size-4 shrink-0 fill-current"
								/>
								<span className={TYPE.statSm}>
									{stars.toLocaleString('en-US')}
								</span>
							</span>
						</Fact>
					) : null}
					{latestVersion ? (
						<Fact label="Latest release">
							<span className={TYPE.statSm}>{latestVersion}</span>
						</Fact>
					) : null}
					<Fact label={SKILLS_HERO.agentsLabel}>
						<span className={TYPE.subhead}>Any agent</span>
					</Fact>
				</dl>
			</div>

			{/* The ask. Stripes are the spec's structural fill (DESIGN rule 5), so
			    the panel reads as an object sitting on the page rather than as a
			    third column of copy. */}
			<div className="border-border bg-muted bg-stripes-muted flex items-center border-t p-8 sm:px-[34px] sm:py-9 lg:border-l lg:border-t-0">
				<CoursePanel />
			</div>
		</header>
	)
}

function Fact({
	label,
	children,
}: {
	label: string
	children: React.ReactNode
}) {
	return (
		<div>
			<dd className="flex items-center">{children}</dd>
			<dt className={cn(TYPE.micro, 'mt-1.5 text-[color:var(--ah-fg-label)]')}>
				{label}
			</dt>
		</div>
	)
}

/**
 * The free email course, as a panel rather than a band.
 *
 * `SkillsCourseCta` (the wide version used under a changelog entry) makes the
 * same offer, but a 400px rail is not a row: the icon, the headline and the
 * button cannot sit on one line, and that copy is written for a full-width
 * strip.
 */
function CoursePanel() {
	return (
		<div className="rounded-lg border border-[color:var(--ah-accent-line)] bg-[color:var(--ah-accent-wash)] px-6 pb-[26px] pt-6">
			<p className={cn(TYPE.micro, 'text-primary mb-3')}>
				{SKILLS_COURSE_PANEL.eyebrow}
			</p>
			<h2 className={cn(TYPE.panelTitle, 'mb-2 text-balance')}>
				{SKILLS_COURSE_PANEL.heading}
			</h2>
			<p
				className={cn(
					TYPE.metaProse,
					'mb-[18px] text-[color:var(--ah-fg-muted)]',
				)}
			>
				{SKILLS_COURSE_PANEL.body}
			</p>
			<Link
				href={SKILLS_COURSE_PANEL.href}
				className={cn(
					TYPE.meta,
					'bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring group inline-flex items-center gap-2 rounded-[9px] px-[17px] py-[11px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
				)}
			>
				{SKILLS_COURSE_PANEL.ctaLabel}
				<ArrowRight
					aria-hidden
					className="ease-out-quart size-3.5 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
				/>
			</Link>
		</div>
	)
}
