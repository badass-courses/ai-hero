import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { getLatestCohort, getUpcomingCohort } from '@/lib/upcoming-cohort-query'
import { log } from '@/server/logger'
import { formatCohortDateRange } from '@/utils/format-cohort-date'
import { ArrowRight } from 'lucide-react'

/**
 * The cohort section (wireframe § ⑨). The most commercially important block on
 * the page, so it gets the page's strongest composition: the same two-column
 * image-led split as the hero, with the artwork bleeding to the container
 * edge. Every cohort has an `image`; leading with it is what separates this
 * from the editorial rows around it.
 *
 * Deliberately NOT a bordered card inside a bordered section. The section IS
 * the container: one tinted surface, one rule top and bottom, no inner box.
 *
 * Two states, and the difference is commercial, not cosmetic:
 *
 * - **Purchasable** — a live product inside its enrollment window. CTA enrolls.
 * - **Waitlist** — a cohort exists but cannot be bought. Never shows a price:
 *   pricing something nobody can buy reads as a live offer and dead-ends.
 *
 * One CTA. The previous version had "Join the waitlist" and "See all the
 * details" side by side pointing at the same URL, which is two buttons that
 * do the same thing.
 */
export async function UpcomingCohort({
	eyebrow = 'Cohort-based course',
}: { eyebrow?: string } = {}) {
	const purchasable = await getUpcomingCohort()
	const cohort = purchasable ?? (await getLatestCohort())

	if (!cohort) {
		await log.info('landing.upcomingCohort.noMatch', {})
		return null
	}

	const isOpen = Boolean(purchasable)
	const dateLabel = cohort.startsAt
		? formatCohortDateRange(cohort.startsAt, null).dateString
		: null

	return (
		<section
			aria-labelledby="cohort-heading"
			className="border-border bg-muted/25 grid grid-cols-1 items-center border-y md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]"
		>
			<div className="flex flex-col justify-center gap-6 px-8 py-14 sm:px-16 md:py-20">
				<div className="flex flex-col gap-4">
					<p className="text-primary font-mono text-[11px] font-medium uppercase tracking-wider">
						{eyebrow}
					</p>
					<h2
						id="cohort-heading"
						className="text-balance text-3xl font-medium leading-tight tracking-tight sm:text-4xl"
					>
						{cohort.title.trim()}
					</h2>
					{cohort.description ? (
						<p className="max-w-[52ch] text-balance text-base leading-relaxed opacity-80">
							{cohort.description}
						</p>
					) : null}
				</div>

				<dl className="border-border flex flex-wrap gap-x-8 gap-y-2 border-t pt-5 text-sm">
					{isOpen && dateLabel ? (
						<div className="flex items-baseline gap-2">
							<dt className="text-muted-foreground">Starts</dt>
							<dd className="font-medium tabular-nums">{dateLabel}</dd>
						</div>
					) : null}
					<div className="flex items-baseline gap-2">
						<dt className="text-muted-foreground">Format</dt>
						<dd className="font-medium">Live, with Matt</dd>
					</div>
				</dl>

				<div className="flex flex-col gap-3">
					<Link
						href={`/cohorts/${cohort.slug}`}
						className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring group inline-flex h-12 w-fit items-center gap-2 rounded-full px-7 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
					>
						{isOpen ? 'See the cohort' : 'Join the waitlist'}
						<ArrowRight
							aria-hidden
							className="ease-out-quart size-4 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
						/>
					</Link>
					{!isOpen ? (
						<p className="text-muted-foreground text-xs">
							Enrollment is closed between cohorts. Join the waitlist and you
							will hear when the next one opens.
						</p>
					) : null}
				</div>
			</div>

			{cohort.image ? (
				<Link
					href={`/cohorts/${cohort.slug}`}
					aria-hidden
					tabIndex={-1}
					className="group flex items-center px-8 pb-14 sm:px-16 md:py-20 md:pl-0"
				>
					{/* Native 16:9, not a cropped fill. Every resource image on the
					    site is a thumbnail ratio, and this artwork is a designed title
					    card — cropping it to fill a tall cell both sliced the type and
					    made the one image on the page that is a different shape from
					    all the others. */}
					<span className="border-border relative block aspect-video w-full overflow-hidden border">
						<Image
							src={cohort.image}
							alt=""
							fill
							sizes="(min-width: 768px) 45vw, 100vw"
							className="object-cover transition-transform duration-500 ease-out group-hover:scale-[1.02] motion-reduce:transform-none motion-reduce:transition-none"
						/>
					</span>
				</Link>
			) : null}
		</section>
	)
}
