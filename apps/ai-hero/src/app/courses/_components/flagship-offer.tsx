import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { formatStartsAt } from '@/components/landing/format'
import { TYPE } from '@/components/landing/type'
import { getCachedCohort } from '@/lib/cohorts-query'
import { FLAGSHIP_SECTION, FLAGSHIP_WAITLIST } from '@/lib/courses-content'
import type { UpcomingCohortSummary } from '@/lib/upcoming-cohort-query'
import { getResourcePath } from '@/utils/resource-paths'
import { ArrowRight } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

/**
 * The flagship cohort, as the page's dominant block.
 *
 * It used to render through `ResourceRow` — the *listing* component, the one
 * the landing page uses for "here is one of eight blog posts", and the one
 * that still renders the not-yet-released crash course further down this page.
 * The single thing this page exists to sell therefore arrived at exactly the
 * same visual weight as a course that does not exist yet.
 *
 * Two more things followed from that and are fixed here:
 *
 * 1. **One title, not two.** The section's `h2` was the slogan ("Stop
 *    babysitting your agent…") and the product's actual name appeared
 *    smaller, inside the row, underneath it. A reader met a slogan as the
 *    heading and the product as a subordinate line item. Now the product name
 *    is the `h2` and the slogan is its deck — which is what a slogan is for.
 * 2. **The offer is one block.** Enrollment state used to sit in a separate
 *    bordered band below the row. It is part of the offer, so it sits inside
 *    it, in the same callout treatment the landing page uses.
 *
 * Composition is `UpcomingCohort`'s, deliberately: 2:1, copy left, title card
 * right, one pill CTA. That block is the landing page's most commercially
 * important composition and this is the same product, so the two should not
 * be arguing about how a cohort looks.
 */
export async function FlagshipOffer({
	flagship,
	isPurchasable,
}: {
	flagship: UpcomingCohortSummary | null
	isPurchasable: boolean
}) {
	// Degenerate: no published cohort at all. Never render a hole — fall back to
	// the section copy and point at the capture form.
	if (!flagship) {
		return (
			<OfferShell
				title="AI Coding for Real Engineers"
				deck={FLAGSHIP_SECTION.heading}
				body="The flagship cohort. Join the list below to hear when the next one is scheduled."
				statusLabel="Enrollment"
				statusValue="Not currently scheduled"
				ctaLabel="Get the dates"
				ctaHref="#join"
			/>
		)
	}

	const cohort = await getCachedCohort(flagship.slug)
	const startsAt = flagship.startsAt ? new Date(flagship.startsAt) : null
	// Dates only render when they are in the future. A past "Starts 3 June"
	// reads as a live offer you already missed.
	const startsInFuture = startsAt !== null && startsAt.getTime() > Date.now()
	const timezone = cohort?.fields?.timezone ?? 'America/Los_Angeles'
	const href = getResourcePath('cohort', flagship.slug, 'view')

	return (
		<OfferShell
			title={flagship.title}
			deck={FLAGSHIP_SECTION.heading}
			body={
				isPurchasable ? FLAGSHIP_SECTION.strapline : FLAGSHIP_WAITLIST.description
			}
			statusLabel={isPurchasable && startsInFuture ? 'Starts' : 'Enrollment'}
			statusValue={
				isPurchasable
					? startsInFuture && startsAt
						? formatStartsAt(startsAt, timezone)
						: 'Open now'
					: 'Waitlist open — the list gets the dates first'
			}
			ctaLabel={isPurchasable ? 'See the cohort' : 'Join the waitlist'}
			ctaHref={href}
			image={cohort?.fields?.image}
		/>
	)
}

function OfferShell({
	title,
	deck,
	body,
	statusLabel,
	statusValue,
	ctaLabel,
	ctaHref,
	image,
}: {
	title: string
	deck: string
	body: string
	statusLabel: string
	statusValue: string
	ctaLabel: string
	ctaHref: string
	image?: string
}) {
	return (
		<section
			aria-labelledby="flagship-heading"
			className="border-border bg-muted/25 grid grid-cols-1 items-center border-b md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
		>
			<div className="flex flex-col justify-center gap-6 px-8 py-14 sm:px-16 md:py-20">
				<div className="flex flex-col gap-4">
					<p className={cn(TYPE.micro, 'text-primary')}>
						{FLAGSHIP_SECTION.eyebrow}
					</p>
					<h2 id="flagship-heading" className={cn(TYPE.heading, 'text-balance')}>
						{title}
					</h2>
					<p className={cn(TYPE.deck, 'text-balance opacity-80')}>{deck}</p>
					<p className={cn(TYPE.body, 'max-w-[58ch] opacity-80')}>{body}</p>
				</div>

				{/* Enrollment state as a callout, not a ruled-off band. Same treatment
				    as the landing cohort block: a note attached to the offer above
				    it, so it must not draw a boundary. */}
				<dl className={cn(TYPE.metaProse, 'bg-muted flex w-fit flex-col gap-0.5 px-4 py-3')}>
					<dt className="text-muted-foreground">{statusLabel}</dt>
					<dd className="font-medium tabular-nums">{statusValue}</dd>
				</dl>

				<Link
					href={ctaHref}
					className={cn(TYPE.meta, 'bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring group inline-flex h-12 w-fit items-center gap-2 rounded-full px-7 font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2')}
				>
					{ctaLabel}
					<ArrowRight
						aria-hidden
						className="ease-out-quart size-4 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
					/>
				</Link>
			</div>

			{image ? (
				<Link
					href={ctaHref}
					aria-hidden
					tabIndex={-1}
					className="group flex items-center px-8 pb-14 sm:px-16 md:py-20 md:pl-0"
				>
					{/* Native 16:9. The artwork is a designed title card; cropping it to
					    fill a tall cell slices the type on it. */}
					<span className="border-border relative block aspect-video w-full overflow-hidden border">
						<Image
							src={image}
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
