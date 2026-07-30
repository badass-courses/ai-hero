import * as React from 'react'
import Link from 'next/link'
import { TYPE } from '@/components/landing/type'
import { SKILLS_HERO } from '@/lib/skills-content'
import { ArrowRight } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

/**
 * Where the Map sends a reader who has finished reading it.
 *
 * The Map answers "what would you like to do"; every answer eventually needs
 * the thing that does it, and the page had no route to `/skills` anywhere on
 * it — not in the goal sections, not in What's New, not in the bookend. A
 * reader who scrolled to the end of the wayfinding page was offered a
 * newsletter and nothing to actually go and use.
 *
 * This is deliberately the SAME object as a lesson's "Up next" cell
 * (`PostUpNextPager`): band surface, micro eyebrow in accent, panel title, and
 * the filled circular arrow pinned right. That pairing is already how this site
 * says "here is the next thing" — a reader meets it at the end of every lesson
 * — so the Map ends in a sentence they have already been taught to read rather
 * than in a new one invented for this page.
 *
 * It is the LAST thing on the page, under the newsletter bookend. The
 * newsletter is an ask the reader can decline, and a declined ask is a poor
 * note for a wayfinding page to end on; a door is a better one.
 */
export function MapSkillsNext() {
	return (
		<section aria-label="Next: the skill system" className="border-t">
			<Link
				href="/skills"
				className="focus-visible:ring-ring group flex items-center gap-5 bg-[color:var(--ah-band)] px-[18px] py-9 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset sm:px-11"
			>
				<span className="min-w-0">
					<span className={cn(TYPE.micro, 'text-primary mb-2.5 block')}>
						Next · The Skill System
					</span>
					<span className={cn(TYPE.panelTitle, 'mb-2 block text-pretty')}>
						{SKILLS_HERO.title}
					</span>
					<span
						className={cn(
							TYPE.metaProse,
							'block max-w-[58ch] text-pretty text-[color:var(--ah-fg-muted)]',
						)}
					>
						{SKILLS_HERO.tagline} {SKILLS_HERO.taglineTail}
					</span>
				</span>
				{/* The spec's filled circular arrow: gold in dark, ink in light
				    (DESIGN rule 8's documented invert). Identical to the pager's. */}
				<span
					aria-hidden
					className="text-background dark:bg-accent-fill dark:text-accent-fill-foreground bg-foreground ease-out-quart ml-auto flex size-11 flex-none items-center justify-center rounded-full transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
				>
					<ArrowRight className="size-5" />
				</span>
			</Link>
		</section>
	)
}
