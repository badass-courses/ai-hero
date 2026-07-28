import * as React from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

import { SectionHeader } from './section-header'

import { TYPE } from './type'

import { cn } from '@coursebuilder/utils/cn'

/**
 * The homepage's activity ladder: what you might want to *do*, in rungs.
 *
 * Replaces a topic grid ("Ship better code" / "Understand AI fundamentals" /
 * "Level up your workflow"). Topics describe the library; activities describe
 * the reader.
 *
 * Authored in the CMS body, the same shape `TopicsGrid` used:
 *
 *   <ActivityLadder heading="…" intro="…" ctaHref="/learn" ctaLabel="…">
 *     <ActivityRung
 *       audience="If you have never written code"
 *       question="How do I get started?"
 *       moreHref="/topics/learn-how-llms-think"
 *       moreLabel="More fundamentals"
 *     >
 *       <Resource slugOrId="what-is-an-llm" variant="ladder" />
 *     </ActivityRung>
 *   </ActivityLadder>
 *
 * The questions match `GOAL_SECTIONS` on `/learn` — Matt's three audience
 * buckets — so a visitor who clicks through to the Map finds the shape they
 * just scanned rather than a competing one. That correspondence is editorial,
 * not enforced in code: keeping it in the CMS is what lets Matt retune the
 * homepage's framing without a deploy, which is the point of authoring it
 * here.
 *
 * The design problem this block exists to solve: an experienced developer will
 * not click a tab marked "beginner", and the fundamentals are exactly what
 * most of them are missing. So there are no tabs and no accordions. Open
 * rungs, each labelled with who it is for, all readable in one pass — someone
 * scrolling to "If you use an agent every day" still reads the titles above it
 * on the way. Self-location without self-exclusion.
 */
/**
 * The order rungs draw from `--topic-1…6` (globals.css). Deliberately not
 * 1,2,3,…: those tokens are ordered by hue angle, so reading them in sequence
 * hands out three neighbouring warms before it reaches anything cool.
 *
 * vermilion → gold → blue → green → magenta → orange.
 */
const HUE_ORDER = [1, 3, 5, 4, 6, 2] as const

export function ActivityLadder({
	heading,
	intro,
	ctaHref,
	ctaLabel,
	children,
}: {
	heading?: string
	intro?: string
	/** Optional "see everything" destination for the section header. */
	ctaHref?: string
	ctaLabel?: string
	children: React.ReactNode
}) {
	return (
		<section aria-label={heading ?? 'Where to start'} className="border-b">
			{heading || intro ? (
				<SectionHeader heading={heading} linkHref={ctaHref} linkLabel={ctaLabel}>
					{intro}
				</SectionHeader>
			) : null}

			{/* Rows rather than columns: the rungs are a sequence a reader walks
			    down, and columns would set them side by side as equal alternatives
			    to pick between.

			    No rule between rungs. Each already carries an internal hairline
			    stack (its resource rows), so a divider on top of that made four
			    lines where the eye needed one break, and the page as a whole leans
			    hard on horizontal rules already. Whitespace does the separating. */}
			{/* Hue is assigned by position, never authored. An author choosing a
			    colour per rung is an author who can pick the same one twice, or
			    pick one that fights the rung above it; the whole value here is
			    that adjacent rungs differ, which is a property of the sequence
			    rather than of any one rung. Reordering reshuffles the hues, and
			    that is correct — they are wayfinding within this page, not a
			    persistent identity for the topic.

			    Not `i % 6`. Walking the palette in order gave the first three
			    rungs hues 25, 50 and 95 — all warm, all reading as one orange
			    family, which is the opposite of the point. `HUE_ORDER` steps
			    around the wheel instead of along it, so consecutive rungs are
			    always far apart in hue and a four-rung ladder (the current
			    shape) gets red / gold / blue / green. */}
			<ul className="flex flex-col gap-4 pb-4">
				{React.Children.map(children, (child, i) =>
					React.isValidElement(child)
						? React.cloneElement(child as React.ReactElement<{ hue?: number }>, {
								hue: HUE_ORDER[i % HUE_ORDER.length],
							})
						: child,
				)}
			</ul>
		</section>
	)
}

/**
 * One rung: who it is for, the question they are asking, a few resources, and
 * the topic page holding the rest.
 *
 * `audience` is deliberately a plain phrase ("If you can already code"), not a
 * difficulty badge. "Beginner" invites people to rule themselves out; "if you
 * can already code" lets them locate themselves while the rung above stays
 * just as readable.
 *
 * Children are `<Resource variant="ladder" />`, wrapped in `<li>`s here so an
 * author can add or drop one without touching a border.
 */
export function ActivityRung({
	audience,
	question,
	moreHref,
	moreLabel,
	hue,
	children,
}: {
	audience: string
	question: string
	/** Topic page holding the rest. Omit for a rung with no "more" destination. */
	moreHref?: string
	moreLabel?: string
	/**
	 * 1–6, injected by `ActivityLadder` from the rung's position. Not for
	 * authors — see the note on the `<ul>` above.
	 */
	hue?: number
	children: React.ReactNode
}) {
	return (
		<li
			// `--topic` is the rung's whole colour surface. Everything inside it
			// that takes a hue reads this one variable, so the audience label, the
			// row hover fill and the arrows cannot drift apart.
			style={
				hue
					? ({ '--topic': `var(--topic-${hue})` } as React.CSSProperties)
					: undefined
			}
			className="grid grid-cols-1 gap-x-12 gap-y-6 px-8 py-6 sm:px-16 md:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]"
		>
			<div className="flex flex-col gap-2">
				{/* The one piece of text on the rung that is coloured. It is also the
				    one that answers "is this row for me?", which is the question the
				    colour is helping a scrolling reader re-ask further down. */}
				<p
					className={cn(
						TYPE.micro,
						'[color:var(--topic,var(--muted-foreground))]',
					)}
				>
					{audience}
				</p>
				<h3 className={cn(TYPE.subhead, 'text-balance')}>
					{question}
				</h3>
				{moreHref ? (
					<Link
						href={moreHref}
						className={cn(TYPE.meta, 'group [color:var(--topic,var(--muted-foreground))] hover:opacity-70 focus-visible:ring-ring mt-1 inline-flex w-fit items-center gap-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2')}
					>
						{moreLabel ?? 'More'}
						<ArrowRight
							aria-hidden
							className="ease-out-quart size-3.5 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
						/>
					</Link>
				) : null}
			</div>

			{/* Dividers come from the rows themselves (see `ResourceLadderItem`);
			    the last one drops its rule so the rung ends on whitespace. */}
			<ul className="flex flex-col md:-mt-2 [&>li:last-child_a]:border-b-0">
				{React.Children.map(children, (child) => (
					<li>{child}</li>
				))}
			</ul>
		</li>
	)
}
