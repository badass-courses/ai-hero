'use client'

import Link from 'next/link'
import { useCtaGate } from '@/hooks/use-cta-gate'
import { hasJoinedOfferWaitlist } from '@/lib/cta-gating'
import type { NextOffer } from '@/lib/next-offer'
import { api } from '@/trpc/react'
import { formatCohortDateRange } from '@/utils/format-cohort-date'
import { cn } from '@coursebuilder/utils/cn'
import { ArrowRight } from 'lucide-react'

export function CourseCtaClient({
	offer,
	className,
}: {
	offer: NextOffer
	className?: string
}) {
	const { subscriber, isResolved: subscriberResolved } = useCtaGate()
	const { data: ownership, status: ownershipStatus } =
		api.ability.ownsResource.useQuery(
			{ resourceId: offer.id },
			{
				staleTime: 5 * 60 * 1000,
				refetchOnWindowFocus: false,
				retry: 1,
			},
		)

	// Hold the whole card until both reader-specific answers are known. This
	// avoids flashing a purchase or waitlist ask at someone who already acted.
	if (!subscriberResolved || ownershipStatus === 'pending') return null

	if (
		ownership?.owned === true ||
		hasJoinedOfferWaitlist(subscriber, offer.waitlist)
	) {
		return null
	}

	const isEnrolling = offer.kind === 'cohort-enroll'
	const isSale = offer.kind === 'sale'
	const eyebrow = isSale ? 'On sale now' : 'Ready to go deeper?'
	const startsLabel = offer.startsAt
		? formatCohortDateRange(offer.startsAt, null, offer.timezone).dateString
		: null
	const description = isSale
		? `${offer.discount?.formatted} off, for a limited time.`
		: isEnrolling
			? startsLabel
				? `Next cohort starts ${startsLabel}.`
				: 'Join the next cohort and build these habits alongside other engineers.'
			: offer.kind === 'workshop-waitlist'
				? 'Not out yet. Join the waitlist and you hear the moment it ships.'
				: 'Enrollment is closed between cohorts. Join the waitlist to hear when the next one opens.'
	const label = offer.kind === 'cohort-waitlist' ? offer.label : 'Learn more'
	const tocLabel = isSale ? `Save ${offer.discount?.formatted}` : offer.label

	return (
		<aside
			id="course-cta"
			data-toc-cta="course"
			data-toc-label={tocLabel}
			className={cn(
				'not-prose border-primary/30 bg-primary/5 scroll-mt-(--nav-height) my-12 flex flex-col gap-4 rounded-xl border p-6 sm:p-8',
				className,
			)}
		>
			<div className="flex flex-col gap-2">
				<span className="text-primary font-mono text-[11px] font-medium uppercase tracking-wider">
					{eyebrow}
				</span>
				<h2 className="text-foreground text-balance text-2xl font-semibold leading-tight tracking-tight">
					{offer.title}
				</h2>
				<p className="text-foreground/80 text-balance text-base leading-relaxed">
					{description}
				</p>
			</div>
			<div>
				<Link
					href={offer.href}
					className="bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring focus-visible:ring-offset-background group relative isolate inline-flex h-[46px] items-center gap-2 overflow-hidden rounded-[9px] px-5 text-[15px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
				>
					{label}
					<ArrowRight
						className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none"
						aria-hidden="true"
					/>
					<span
						aria-hidden
						style={{ backgroundSize: '200% 100%' }}
						className="animate-shine pointer-events-none absolute inset-0 -z-10 rounded-[inherit] bg-[linear-gradient(120deg,rgba(255,255,255,0)40%,rgba(255,255,255,1)50%,rgba(255,255,255,0)60%)] opacity-10 motion-reduce:animate-none dark:opacity-20"
					/>
				</Link>
			</div>
		</aside>
	)
}
