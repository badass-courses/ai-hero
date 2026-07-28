import * as React from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

/**
 * Homepage topic columns: a heading, a few hand-picked resources, and a link
 * to the full topic. Authored in the CMS body as
 *
 *   <TopicsGrid>
 *     <TopicsGridColumn heading="…" moreHref="/topics/…">
 *       <Resource slugOrId="…" variant="list" />
 *     </TopicsGridColumn>
 *   </TopicsGrid>
 *
 * Built for 3 columns and tolerant of 2 to 4: the grid caps at 3 across so a
 * fourth column wraps rather than squeezing all four into an unreadable row.
 *
 * Hairlines come from the container (`bg-border` + `gap-px`) with each cell
 * painting its own `bg-background`, never per-column borders (DESIGN.md
 * rule 2). Short rows get `aria-hidden` filler cells so the trailing line
 * stays clean, the same treatment as `ResourceGrid`.
 */
export function TopicsGrid({ children }: { children: React.ReactNode }) {
	const columns = React.Children.toArray(children)
	const count = columns.length
	const smFillers = count % 2 === 0 ? 0 : 1
	const lgRemainder = count % 3
	const lgFillers = lgRemainder === 0 ? 0 : 3 - lgRemainder

	return (
		<section className="border-border bg-border grid w-full grid-cols-1 gap-px border-y sm:grid-cols-2 lg:grid-cols-3">
			{columns}
			{Array.from({ length: smFillers }).map((_, i) => (
				<div
					key={`sm-${i}`}
					aria-hidden
					className="bg-background hidden sm:block lg:hidden"
				/>
			))}
			{Array.from({ length: lgFillers }).map((_, i) => (
				<div
					key={`lg-${i}`}
					aria-hidden
					className="bg-background hidden lg:block"
				/>
			))}
		</section>
	)
}

export function TopicsGridColumn({
	heading,
	moreHref,
	moreLabel,
	children,
}: {
	heading: string
	/** Link to the full topic. Omit for a column with no "more" destination. */
	moreHref?: string
	/** Defaults to "More" (the wireframe's per-column link). */
	moreLabel?: string
	children: React.ReactNode
}) {
	return (
		<div className="bg-background flex flex-col">
			<h3 className="text-balance px-6 pb-3 pt-8 text-xl font-semibold leading-tight tracking-tight sm:px-8">
				{heading}
			</h3>
			{/* No gap: the list items own their padding, so they read as one stack
			    rather than three floating chips. */}
			<div className="flex flex-col">{children}</div>
			{moreHref ? (
				<Link
					href={moreHref}
					className="group text-muted-foreground hover:text-foreground focus-visible:ring-ring mt-auto inline-flex items-center gap-1.5 px-6 pb-8 pt-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset sm:px-8"
				>
					{moreLabel ?? 'More'}
					<ArrowRight
						aria-hidden
						className="ease-out-quart size-3.5 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
					/>
				</Link>
			) : (
				<div className="pb-8" />
			)}
		</div>
	)
}
