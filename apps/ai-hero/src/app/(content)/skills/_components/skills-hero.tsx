import * as React from 'react'
import Link from 'next/link'
import { Icon } from '@/components/brand/icons'
import { BADGE_OUTLINE, TYPE } from '@/components/landing/type'
import { getRepoStarCount } from '@/lib/github-stars-query'
import {
	SKILLS_COURSE_PANEL,
	SKILLS_HERO,
	SKILLS_REPO_URL,
	SKILLS_SH_BADGE_URL,
	SKILLS_SH_URL,
} from '@/lib/skills-content'
import { Star } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

import { CourseMark } from './course-mark'
import { SkillsCourseForm } from './skills-course-form'
import { SkillsInstallOptions } from './skills-install-options'

/**
 * The page's HEAD (`Skills Page.dc.html` § HEAD), rebuilt from Amy's review
 * (2026-07-30) and the design return that answered it.
 *
 * ## Single column is the layout; the rail is the wide-screen bonus
 *
 * The previous version was `minmax(0,1fr) 400px` with the free-course CTA in
 * the right cell. Amy: *"this CTA on the side will get ignored… the signup
 * should be in the main body of the hero. OR, if we want to keep this sidebar,
 * make it a list of the skills."* Both halves are taken: **the ask moves into
 * the body, and the rail gets the install block** — something a reader acts on
 * rather than a second ask they skip.
 *
 * The split is a **container query, not a media query**. `/skills` renders
 * inside `HubLayout`, so the hero's width is the page minus the hub sidebar,
 * and a media query would be answering a question about the viewport that
 * nobody asked. On a container query the sidebar's width stops being the hero's
 * problem, and the 900–1200px band where a fixed rail against a narrowed column
 * becomes "two columns arguing" is never entered: the split is conditional on
 * fit.
 *
 * ## The rail width is arithmetic, not taste
 *
 * JetBrains Mono's advance is exactly `0.6em`, so a 40-character command at
 * 12px is 288px of glyphs. Plus 32 padding, a 30px copy button and its gap, the
 * minimum row is **358px**; **440px** is that with breathing room. The left
 * column never goes under 544px (`34rem`), which is where the 52px `h1` stops
 * setting badly.
 *
 * ## Order
 *
 * Headline → lead → stats → signup → install → proof. The stats moved UP from
 * the foot of the hero: they are the credibility line, and the star count is
 * the most persuasive number on the page. They are a flex row rather than a
 * three-cell hairline grid because a grid breaks when a stat is absent, and a
 * missing value here drops its item rather than printing a placeholder.
 */
export async function SkillsHero({
	stars: starsProp,
	skillCount,
}: {
	/**
	 * GitHub star count, consolidated at the page level (spec §7). When omitted
	 * the component fetches it itself so standalone usage still works.
	 */
	stars?: number | null
	/** Live count of published skills in the CMS list. */
	skillCount?: number
} = {}) {
	const stars =
		starsProp !== undefined
			? starsProp
			: await getRepoStarCount(SKILLS_HERO.repoOwner, SKILLS_HERO.repoName)

	return (
		<header
			id="skills-hero"
			// `container-type: inline-size` is what makes the grid below query the
			// hero's own width rather than the window's.
			className="border-border @container border-b"
		>
			<div className="grid grid-cols-1 gap-y-10 px-[18px] pb-11 pt-12 sm:px-11 @[1080px]:grid-cols-[minmax(34rem,1fr)_440px] @[1080px]:gap-x-10">
				<div className="min-w-0">
					{/* No eyebrow, and nothing in its place. "Free · open source · 21
					    skills" failed gate 1 on "the system"; the surviving facts are in
					    the stat row and the rail foot, which is where the mockup puts
					    them. The hero opens on the headline. */}
					<h1 className={cn(TYPE.title, 'mb-4 max-w-[22ch] text-balance')}>
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

					<Stats stars={stars} />

					{/* The ask, in the body of the hero. No panel, no stripes, no box:
					    a de-emphasized container is exactly what Amy said gets ignored. */}
					<CourseCta />
				</div>

				{/* The rail holds something a reader acts on. Below 1080px of hero
				    container it is simply the next block down the single column, which
				    is the layout the page actually ships on most laptops.

				    And in that state it needs a rule above it. Side by side, the gap
				    between the columns is what separates the ask from the install
				    block; stacked, they run into each other and the reader gets two
				    unrelated things with nothing between them. The rule only exists
				    where the columns do not. */}
				<SkillsInstallOptions
					className="border-border min-w-0 border-t pt-10 @[1080px]:border-t-0 @[1080px]:pt-0"
					skillCount={skillCount}
				/>
			</div>
		</header>
	)
}

/**
 * The credibility line, directly under the lead.
 *
 * Flex with a gap rather than a three-cell hairline grid: a grid with a fixed
 * column count breaks when a stat is absent, and both the GitHub count and the
 * Skills.sh badge can be. Here a missing value drops its item and the row
 * closes up.
 *
 * Two items, not three, and they are different kinds of thing. The star count
 * is a stat and gets the caption treatment. The Skills.sh badge is a live
 * remote image with its own baked-in label, so captioning it would be saying
 * "installs" twice; it pairs with the GitHub link instead — **the number is the
 * claim, the link is the receipt**. Both sit at the badge's fixed 20px height
 * so neither reads as a button competing with the ask below.
 */
function Stats({ stars }: { stars: number | null }) {
	return (
		<dl className="mb-4 flex flex-wrap items-end gap-x-[30px] gap-y-5">
			{stars !== null ? (
				<div className="flex items-center gap-[11px]">
					<Star
						aria-hidden
						className="text-primary size-[22px] shrink-0 fill-current"
					/>
					{/* `flex-col-reverse`: a `<dl>` wants `<dt>` before `<dd>` in the
					    DOM, and `TYPE.statLabel` is a caption that sits BELOW its
					    number. Above it, it is another eyebrow. */}
					<div className="flex flex-col-reverse">
						{/* `mt-0.5`, overriding the constant's `mt-1.5`. `TYPE.stat` sets
						    `leading-none`, so the numeral's box already sits tight to its
						    baseline and the caption's default 6px reads as a gap rather
						    than as a caption. */}
						<dt className={cn(TYPE.statLabel, 'mt-0.5')}>GitHub stars</dt>
						{/* A step down at every width (was 22 / 26 / 31). The number is the
						    hero's credibility line, not its headline — at 31px it was
						    within a hair of the `h1` above it and read as a second title. */}
						<dd className={cn(TYPE.stat, 'text-[20px] @[560px]:text-[23px] @[1080px]:text-[27px]')}>
							{stars.toLocaleString('en-US')}
						</dd>
					</div>
				</div>
			) : null}
			{/* Stacked, not side by side. Two 20px chips in a row read as a pair of
			    buttons offering the same kind of thing, and these are not: one is a
			    live number, the other is where the code lives. Down the column they
			    read as two lines of one credential block.

			    The `dl` is `items-end`, so the taller stack sets the row's baseline
			    and the star count beside it still sits on it. */}
			<div className="flex flex-col items-start gap-2.5">
				<dt className="sr-only">Total skill installs</dt>
				<dd className="flex flex-col items-start gap-2.5">
					<Link
						href={SKILLS_SH_URL}
						target="_blank"
						rel="noreferrer"
						className="focus-visible:ring-ring inline-flex focus-visible:outline-none focus-visible:ring-2"
					>
						{/* This is Skills.sh's live, five-minute-cached aggregate badge. A
						    normal img is deliberate: Next image optimization would cache a
						    second copy and make the number less live. */}
						{/* eslint-disable-next-line @next/next/no-img-element */}
						<img
							src={SKILLS_SH_BADGE_URL}
							alt="Live Skills.sh install count"
							width={101}
							height={20}
						/>
					</Link>
					<Link
						href={SKILLS_REPO_URL}
						target="_blank"
						rel="noreferrer"
						className={cn(
							TYPE.badge,
							BADGE_OUTLINE,
							'hover:border-foreground/40 focus-visible:ring-ring inline-flex h-5 items-center gap-1.5 py-0 transition-colors focus-visible:outline-none focus-visible:ring-2',
						)}
					>
						{/* The mark instead of the generic external arrow. It names the
						    destination, which the arrow only implied, and it matches the
						    Skills.sh badge above it — both lines now lead with the logo of
						    the place they point at. `size-3` on the class beats the
						    component's own width/height attributes. */}
						<Icon name="Github" className="size-3 shrink-0" />
						GitHub
					</Link>
				</dd>
			</div>
		</dl>
	)
}

/**
 * The free email course, inline under the stats.
 *
 * The fields are here, not behind a button. A gold link to `/skills/subscribe`
 * was a click spent to reach the same two inputs, and the whole reason the CTA
 * left the rail was that the ask should BE the thing you do.
 *
 * The body ships as three constants swapped at the same container steps as the
 * layout, rather than being truncated at runtime — see `SKILLS_COURSE_PANEL`.
 * Exactly one of the three is visible at any width; the other two are
 * `hidden`, so the sentence a reader gets is a sentence someone wrote.
 */
function CourseCta() {
	return (
		// A rule above it, not a box around it. The hero is one column of copy and
		// this is where it turns into an ask; a hairline says that without giving
		// the ask a de-emphasized container to sit in.
		<div className="border-border mt-3 border-t pt-[22px]">
			<div className="mb-[18px] flex items-start gap-6">
				{/* The slot a spot illustration will take — 96 / 84 / 60px in the
				    design return. Until that art exists the tile keeps its glyph, which
				    is the return's own placeholder, not an invention. */}
				<CourseMark className="size-[60px] flex-none @[560px]:size-[84px] @[1080px]:size-24" />
				<div>
					{/* No eyebrow, and no panel. The heading carries the offer, the body
					    says it is free, and the button says what it starts. */}
					{/* No measure cap and no `text-balance`: this line is short enough
					    to sit on one at most widths, and balancing it broke a one-liner
					    into two even rows for no reason a reader benefits from. Balance
					    is for headings that WILL wrap. */}
					<h2 className={cn(TYPE.subhead, 'mb-2')}>
						{SKILLS_COURSE_PANEL.heading}
					</h2>
					<p
						className={cn(
							TYPE.metaProse,
							'max-w-[46ch] text-pretty text-[color:var(--ah-fg-muted)]',
						)}
					>
						<span className="@[1080px]:inline hidden">
							{SKILLS_COURSE_PANEL.body.full}
						</span>
						<span className="@[940px]:inline @[1080px]:hidden hidden">
							{SKILLS_COURSE_PANEL.body.mid}
						</span>
						<span className="@[940px]:hidden">
							{SKILLS_COURSE_PANEL.body.short}
						</span>
					</p>
				</div>
			</div>
			<SkillsCourseForm />
		</div>
	)
}
