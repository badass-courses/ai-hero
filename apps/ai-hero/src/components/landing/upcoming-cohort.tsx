import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import {
	formatAlumniCount,
	getCachedCohortAlumniCount,
} from '@/lib/cohort-stats'
import { getLatestCohort, getUpcomingCohort } from '@/lib/upcoming-cohort-query'
import { log } from '@/server/logger'
import { formatCohortDateRange } from '@/utils/format-cohort-date'
import { ArrowRight } from 'lucide-react'

import { TYPE } from './type'

import { cn } from '@coursebuilder/utils/cn'

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
	note = 'Dates go to the list first',
}: { eyebrow?: string; note?: string } = {}) {
	const purchasable = await getUpcomingCohort()
	const cohort = purchasable ?? (await getLatestCohort())

	if (!cohort) {
		await log.info('landing.upcomingCohort.noMatch', {})
		return null
	}

	const alumniLabel = formatAlumniCount(
		await getCachedCohortAlumniCount().catch(() => 0),
	)
	const isOpen = Boolean(purchasable)
	const dateLabel = cohort.startsAt
		? formatCohortDateRange(cohort.startsAt, null).dateString
		: null

	return (
		<section
			aria-labelledby="cohort-heading"
			className="border-border grid grid-cols-1 items-center border-b md:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]"
		>
			{/* 64 / 44 / 60, per `Home Page.dc.html` § COHORT. */}
			<div className="flex flex-col justify-center gap-6 px-[18px] py-14 sm:px-11 md:pb-[60px] md:pt-16">
				<div className="flex flex-col gap-4">
					{/* Status first, then what the thing is. The badge is the only
					    piece of this block that changes between visits, so it leads;
					    the eyebrow beside it says what kind of offer follows. */}
					<div className="flex flex-wrap items-center gap-2.5">
						<span
							className={cn(
								TYPE.micro,
								'bg-accent-fill text-accent-fill-foreground rounded-[4px] px-2 py-1.5 leading-none tracking-[0.12em]',
							)}
						>
							{isOpen ? 'Enrolling now' : 'Waitlist open'}
						</span>
						<p className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}>
							{eyebrow}
						</p>
					</div>
					<h2
						id="cohort-heading"
						className={cn(TYPE.sectionOffer, 'max-w-[22ch] text-balance')}
					>
						{cohort.title.trim()}
					</h2>
					{cohort.description ? (
						<p
							className={cn(
								TYPE.body,
								'max-w-[58ch] text-pretty text-[color:var(--ah-fg-body)]',
							)}
						>
							{cohort.description}
						</p>
					) : null}
				</div>

				{/* The meta line carries whatever a reader can act on. Between
				    cohorts that is the enrollment status, not the date the last one
				    ran — "Last cohort June 2026" tells you the thing is over and
				    nothing about what to do next.

				    A filled callout, not a rule above it. A `border-t` here read as
				    the block ending and a new one starting, which is what every
				    other hairline on this page means; this is a note attached to the
				    offer above it. Its own quiet surface says "aside" without
				    claiming a boundary. */}
				{/* A ruled strip, not a filled callout: at two facts side by side
				    the tint read as a button. Rules above and below tie it to the
				    copy it belongs to while still setting it apart from it.

				    Both figures are live — enrollment state from the product, the
				    alumni count from the purchases table.

				    The prototype's strip has THREE facts; this one has two, and the
				    missing one is Commitment ("5–8 hrs / week"). Re-checked against
				    `CohortSchema` (`src/lib/cohort.ts`): the cohort fields are title,
				    description, slug, body, postPurchaseBody, officeHoursSessions,
				    state, visibility, publishedAt, startsAt, endsAt, timezone,
				    cohortTier, maxSeats, discordRoleId, image, socialImage. None of
				    them carries a weekly time commitment, and none of them can be
				    read as one. Restoring the third fact needs a `commitment?:
				    string` field on `CohortSchema` plus an input on the cohort edit
				    form; until that exists the strip stays at two rather than
				    hardcoding a number nobody can vouch for. */}
				<dl
					className={cn(
						TYPE.metaProse,
						'border-border flex flex-wrap gap-x-[34px] gap-y-4 border-y pb-6 pt-5',
					)}
				>
					<div className="flex min-w-0 max-w-[46ch] flex-col gap-1.5">
						<dt className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}>
							{isOpen ? 'Starts' : 'Enrollment'}
						</dt>
						<dd className="text-primary text-base font-medium tabular-nums">
							{isOpen
								? (dateLabel ?? 'Dates to be announced')
								: 'Closed between cohorts'}
						</dd>
					</div>
					{alumniLabel ? (
						<div className="flex flex-col gap-1.5">
							<dt className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}>
								Trained so far
							</dt>
							<dd className="text-base font-medium tabular-nums">
								{alumniLabel} engineers
							</dd>
						</div>
					) : null}
				</dl>

				<div className="flex flex-wrap items-center gap-4">
					<Link
						href={`/cohorts/${cohort.slug}`}
						className={cn(TYPE.meta, 'bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring group inline-flex h-[46px] w-fit items-center gap-2 rounded-[9px] px-5 text-[15px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2')}
					>
						{isOpen ? 'See the cohort' : 'Join the waitlist'}
						<ArrowRight
							aria-hidden
							className="ease-out-quart size-4 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
						/>
					</Link>
					{!isOpen && note ? (
						<p className={cn(TYPE.meta, 'text-[color:var(--ah-fg-subtle)]')}>
							{note}
						</p>
					) : null}
				</div>
			</div>

			{cohort.image ? (
				<Link
					href={`/cohorts/${cohort.slug}`}
					aria-hidden
					tabIndex={-1}
					className="border-border group flex h-full items-center bg-[color:var(--ah-band)] px-[18px] pb-14 sm:px-11 md:border-l md:py-11"
				>
					{/* Native 16:9, not a cropped fill. Every resource image on the
					    site is a thumbnail ratio, and this artwork is a designed title
					    card — cropping it to fill a tall cell both sliced the type and
					    made the one image on the page that is a different shape from
					    all the others. */}
					<span className="border-border relative block aspect-video w-full overflow-hidden rounded-[10px] border">
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
