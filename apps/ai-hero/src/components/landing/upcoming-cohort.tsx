import * as React from 'react'
import Link from 'next/link'
import { getLatestCohort, getUpcomingCohort } from '@/lib/upcoming-cohort-query'
import { formatCohortDateRange } from '@/utils/format-cohort-date'
import { log } from '@/server/logger'
import { ArrowRight } from 'lucide-react'

import { Resource } from './resource'

/**
 * The cohort section (wireframe § ⑨), heading included.
 *
 * The heading lives INSIDE the component on purpose: it used to be a sibling
 * `##` in the MDX, so when no cohort matched, the component returned `null`
 * and the heading survived over empty space. A heading whose body can vanish
 * must own that body.
 *
 * Three states, and the distinction matters commercially:
 *
 * - **Purchasable** — a live product with an open enrollment window. Only here
 *   do we render the full `Resource` row, which shows a price.
 * - **Waitlist** — a cohort exists but cannot be bought (enrollment closed, or
 *   it already ran). Renders the title and dates with a waitlist CTA and NO
 *   price. Showing a price for something nobody can buy is worse than showing
 *   nothing: it reads as a live offer and dead-ends.
 * - **Nothing scheduled** — a `bg-stripes` notice (DESIGN.md rule 15) rather
 *   than an empty band.
 */
export async function UpcomingCohort({
	heading = 'Live cohort',
	detailsLabel = 'See all the details',
}: {
	heading?: string
	detailsLabel?: string
} = {}) {
	const purchasable = await getUpcomingCohort()
	const latest = purchasable ? null : await getLatestCohort()

	if (!purchasable && !latest) {
		await log.info('landing.upcomingCohort.noMatch', {})
		return (
			<CohortShell heading={heading}>
				<div className="bg-stripes flex flex-col items-center gap-5 px-8 py-14 text-center">
					<p className="max-w-[46ch] text-balance text-lg leading-snug tracking-tight">
						The next cohort has not been scheduled yet.
					</p>
					<Link
						href="/courses"
						className="border-border hover:bg-muted focus-visible:ring-ring group inline-flex h-11 items-center gap-2 rounded-full border px-6 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
					>
						Browse the courses
						<Arrow />
					</Link>
				</div>
			</CohortShell>
		)
	}

	// Purchasable: the row carries image, dates and price, all of which are true.
	if (purchasable) {
		return (
			<CohortShell heading={heading}>
				<Resource slugOrId={purchasable.slug} />
				<div className="pt-8">
					<Link
						href={`/cohorts/${purchasable.slug}`}
						className="group text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
					>
						{detailsLabel}
						<Arrow />
					</Link>
				</div>
			</CohortShell>
		)
	}

	// Waitlist: name the cohort, never price it.
	const startsLabel = latest!.startsAt
		? formatCohortDateRange(latest!.startsAt, null).dateString
		: null

	return (
		<CohortShell heading={heading}>
			<div className="border-border flex flex-col items-start gap-5 border p-8 sm:p-10">
				<div className="flex flex-col gap-3">
					<h3 className="text-balance text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
						{latest!.title}
					</h3>
					<p className="text-muted-foreground max-w-[60ch] text-balance text-base leading-relaxed">
						Enrollment is closed between cohorts. Join the waitlist and you will
						hear when the next one opens.
					</p>
				</div>
				<p className="text-muted-foreground font-mono text-xs uppercase tracking-wider">
					{startsLabel ? `Last cohort ran ${startsLabel}` : 'Next dates to be announced'}
				</p>
				<div className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-1">
					<Link
						href={`/cohorts/${latest!.slug}`}
						className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring group inline-flex h-12 items-center gap-2 rounded-full px-7 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
					>
						Join the waitlist
						<Arrow />
					</Link>
					<Link
						href={`/cohorts/${latest!.slug}`}
						className="group text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
					>
						{detailsLabel}
						<Arrow />
					</Link>
				</div>
			</div>
		</CohortShell>
	)
}

function CohortShell({
	heading,
	children,
}: {
	heading: string
	children: React.ReactNode
}) {
	return (
		<section aria-labelledby="cohort-heading" className="border-b">
			<div className="flex flex-col gap-8 px-8 py-16 sm:px-16 md:py-20">
				<h2
					id="cohort-heading"
					className="text-balance text-3xl font-medium leading-tight tracking-tight sm:text-4xl"
				>
					{heading}
				</h2>
				{children}
			</div>
		</section>
	)
}

function Arrow() {
	return (
		<ArrowRight
			aria-hidden
			className="ease-out-quart size-4 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
		/>
	)
}
