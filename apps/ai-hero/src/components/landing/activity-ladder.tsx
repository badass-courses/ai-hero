import * as React from 'react'
import Link from 'next/link'
import {
	ACTIVITY_RUNGS,
	GOAL_SECTIONS,
} from '@/components/navigation/goal-sections-data'
import { getCachedGoalSectionItems } from '@/lib/goal-sections-query'
import { ArrowRight } from 'lucide-react'

import { SectionHeader } from './section-header'

/**
 * The homepage's activity ladder: what you might want to *do*, in three rungs.
 *
 * Replaces a topic grid ("Ship better code" / "Understand AI fundamentals" /
 * "Level up your workflow"). Topics describe the library; activities describe
 * the reader. The taxonomy here is not new — it is `GOAL_SECTIONS`, Matt's own
 * three audience buckets, already shipped on `/learn`. Same questions, same
 * ids, curated down for this surface by `ACTIVITY_RUNGS`. One taxonomy, two
 * depths: a visitor who clicks through to the Map finds the shape they just
 * scanned, not a second competing one.
 *
 * The design problem this block exists to solve: an experienced developer will
 * not click a tab marked "beginner", and the fundamentals are exactly what
 * most of them are missing. So there are no tabs and no accordions. Three open
 * rungs, each labelled with who it is for, all readable in one pass — someone
 * scrolling to "If you use an agent every day" still reads the three titles
 * above it on the way. Self-location without self-exclusion.
 *
 * Renders nothing if no rung resolves, so the page degrades to its neighbours.
 */
export async function ActivityLadder({
	heading = 'What do you want to do?',
	intro,
	ctaHref = '/learn',
	ctaLabel = 'See the full map',
}: {
	heading?: string
	intro?: string
	ctaHref?: string
	ctaLabel?: string
}) {
	const rungs = await loadRungs()
	if (rungs.length === 0) return null

	return (
		<section aria-label="Where to start" className="border-b">
			<SectionHeader heading={heading} linkHref={ctaHref} linkLabel={ctaLabel}>
				{intro}
			</SectionHeader>

			{/* Rows, hairline-separated (DESIGN rule 2), rather than three columns:
			    the rungs are a sequence a reader walks down, and columns would set
			    them side by side as equal alternatives to pick between. */}
			<ul className="border-border bg-border flex flex-col gap-px border-y">
				{rungs.map((rung) => (
					<li
						key={rung.id}
						className="bg-background grid grid-cols-1 gap-x-12 gap-y-6 px-8 py-10 sm:px-16 md:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]"
					>
						<div className="flex flex-col gap-2">
							<p className="text-muted-foreground font-mono text-[11px] font-medium uppercase tracking-wider">
								{rung.audience}
							</p>
							<h3 className="text-balance text-xl font-semibold leading-tight tracking-tight sm:text-2xl">
								{rung.question}
							</h3>
							<Link
								href={rung.moreHref}
								className="group text-muted-foreground hover:text-foreground focus-visible:ring-ring mt-1 inline-flex w-fit items-center gap-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
							>
								{rung.moreLabel}
								<ArrowRight
									aria-hidden
									className="ease-out-quart size-3.5 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
								/>
							</Link>
						</div>

						{/* Titles only. Descriptions here would triple the block's height
						    for copy nobody reads at this depth; the title is what a
						    reader scans and clicks. */}
						<ul className="flex flex-col">
							{rung.items.map((item) => (
								<li key={item.slug}>
									<Link
										href={item.href}
										className="group border-border hover:bg-muted/50 focus-visible:ring-ring flex items-center gap-4 border-b py-3 text-base font-medium leading-snug transition-colors first:pt-0 last:border-b-0 last:pb-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
									>
										<span className="min-w-0 flex-1 text-balance">
											{item.title}
										</span>
										<ArrowRight
											aria-hidden
											className="text-muted-foreground group-hover:text-foreground ease-out-quart size-4 shrink-0 opacity-0 transition-all duration-300 group-hover:translate-x-1 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transform-none motion-reduce:transition-none"
										/>
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

type LoadedRung = {
	id: string
	audience: string
	question: string
	moreHref: string
	moreLabel: string
	items: { slug: string; title: string; href: string }[]
}

/**
 * Joins `ACTIVITY_RUNGS` (homepage curation) to `GOAL_SECTIONS` (the taxonomy)
 * and resolves every slug in ONE batched, cached query. A rung whose goal id
 * has no match in `GOAL_SECTIONS`, or whose picks all fail to resolve, is
 * dropped rather than rendered empty — unpublishing a post should quietly
 * shorten a rung, never leave a heading with nothing under it.
 */
async function loadRungs(): Promise<LoadedRung[]> {
	const allSlugs = ACTIVITY_RUNGS.flatMap((rung) => rung.slugs)
	const resolved = await getCachedGoalSectionItems(allSlugs)

	const rungs: LoadedRung[] = []
	for (const rung of ACTIVITY_RUNGS) {
		const goal = GOAL_SECTIONS.find((g) => g.id === rung.goalId)
		if (!goal) continue

		const items = rung.slugs
			.map((slug) => resolved.get(slug))
			.filter((item): item is NonNullable<typeof item> => Boolean(item))
			.map((item) => ({
				slug: item.slug,
				title: item.title,
				href: item.href,
			}))

		if (items.length === 0) continue

		rungs.push({
			id: goal.id,
			audience: rung.audience,
			question: goal.question,
			moreHref: goal.moreHref,
			// The config's labels carry a trailing arrow for the Map's own link
			// treatment; this one draws its own.
			moreLabel: goal.moreLabel.replace(/\s*→\s*$/, ''),
			items,
		})
	}

	return rungs
}
