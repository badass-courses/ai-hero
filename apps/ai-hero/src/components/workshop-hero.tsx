import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { Markdown as ReactMarkdown } from '@/components/markdown'
import { BADGE_NEUTRAL, BADGE_OUTLINE, TYPE } from '@/components/landing/type'
import { DiscountCountdown } from '@/components/pricing/discount-countdown'
import { COURSES_FEATURED_WORKSHOP, FLAGSHIP_SALE } from '@/lib/courses-content'
import type { NextOffer } from '@/lib/next-offer'
import type { MinimalWorkshop } from '@/lib/workshops'
import { ArrowRight } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

/**
 * A self-paced workshop as the `/courses` hero, for the states where the offer
 * ladder (`next-offer.ts`) ranks it above the cohort — a live sale on it, or
 * its arrival while no cohort is purchasable. Same skeleton as `CohortHero`
 * (eyebrow, name as the heading, description, the ask in the body, image in
 * the rail) so the page reads the same whichever product leads it; the cohort
 * keeps a card in the grid below rather than leaving the page.
 *
 * The ask is always a link, never a form: the workshop page is where buying
 * happens, and this hero only renders when there is something to act on there.
 */
export function WorkshopHero({
	offer,
	workshop,
	headingId = 'featured-workshop-heading',
}: {
	offer: NextOffer
	workshop: MinimalWorkshop
	headingId?: string
}) {
	const image = workshop.fields.coverImage?.url ?? null
	const description =
		workshop.fields.description || COURSES_FEATURED_WORKSHOP.description
	const sale = offer.discount ?? null

	return (
		<section
			aria-labelledby={headingId}
			className="border-border @container scroll-mt-24 border-b"
		>
			<div className="@[1000px]:grid-cols-[minmax(32rem,1fr)_minmax(0,0.72fr)] @[1000px]:gap-x-12 grid grid-cols-1 items-start gap-y-10 px-[18px] py-12 sm:px-11 md:py-[52px]">
				<div className="min-w-0">
					{/* Same slot and same argument as `FLAGSHIP_HERO.eyebrow`: the
					    headline is the course's NAME, so what kind of thing it is —
					    self-paced, no dates — has nowhere else to go. */}
					<p className={TYPE.eyebrow}>{COURSES_FEATURED_WORKSHOP.eyebrow}</p>

					<h1
						id={headingId}
						className={cn(TYPE.title, 'max-w-[20ch] text-balance')}
					>
						{offer.title}
					</h1>

					<p
						className={cn(
							TYPE.statement,
							'text-primary mt-5 max-w-[34ch] text-balance',
						)}
					>
						<ReactMarkdown
							components={{ p: ({ children }) => <>{children}</> }}
						>
							{description}
						</ReactMarkdown>
					</p>

					<div className="mt-10 max-w-[560px]">
						<div className="mb-3 flex flex-wrap items-center gap-2">
							<span
								className={cn(TYPE.badge, BADGE_NEUTRAL, 'inline-flex w-fit')}
							>
								{COURSES_FEATURED_WORKSHOP.badge}
							</span>
							{sale ? (
								<span
									className={cn(
										TYPE.badge,
										BADGE_OUTLINE,
										'text-primary inline-flex w-fit border-[color:var(--ah-accent-line)]',
									)}
								>
									{FLAGSHIP_SALE.label}
								</span>
							) : null}
						</div>
						<h2 className={cn(TYPE.subhead, 'mb-2')}>
							{COURSES_FEATURED_WORKSHOP.heading}
						</h2>
						<p className={cn(TYPE.metaProse, 'text-[color:var(--ah-fg-muted)]')}>
							{COURSES_FEATURED_WORKSHOP.askDescription}
						</p>

						{sale ? (
							<p className={cn(TYPE.meta, 'text-primary mt-3.5')}>
								{COURSES_FEATURED_WORKSHOP.saleClaim(sale.formatted)}
								{sale.expires ? (
									<span className={cn(TYPE.metaMark, 'ml-2')}>
										{FLAGSHIP_SALE.deadlineLabel}{' '}
										<DiscountCountdown date={new Date(sale.expires)} />
									</span>
								) : null}
							</p>
						) : null}

						<div className="mt-4 flex flex-wrap items-center gap-3">
							<Link
								href={offer.href}
								className={cn(
									TYPE.meta,
									'bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring group inline-flex h-[46px] items-center justify-center gap-2 rounded-[9px] px-6 font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
								)}
							>
								{COURSES_FEATURED_WORKSHOP.ctaLabel}
								<ArrowRight
									aria-hidden
									className="ease-out-quart size-4 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
								/>
							</Link>
							{/* The expense-approval path, for the buyer whose real blocker
							    is sign-off. Outline, not gold: the viewport's one gold fill
							    is already spent on the buy (same rule as the team box). */}
							<Link
								href={`/boss/${workshop.fields.slug}`}
								className={cn(
									TYPE.meta,
									'border-foreground/20 hover:bg-secondary focus-visible:ring-ring inline-flex h-[46px] items-center justify-center rounded-[9px] border px-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
								)}
							>
								{COURSES_FEATURED_WORKSHOP.bossLetterLabel}
							</Link>
						</div>
					</div>
				</div>

				<div className="flex flex-col gap-8">
					{image ? (
						<Link
							href={offer.href}
							aria-label={`${offer.title}: ${COURSES_FEATURED_WORKSHOP.imageLinkLabel.toLowerCase()}`}
							className="focus-visible:ring-ring group block rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
						>
							<span className="border-border relative block aspect-video w-full overflow-hidden rounded-[10px] border">
								<Image
									src={image}
									alt=""
									fill
									sizes="(min-width: 1000px) 40vw, 100vw"
									className="object-cover transition-transform duration-500 ease-out group-hover:scale-[1.02] motion-reduce:transform-none motion-reduce:transition-none"
								/>
							</span>
							<span
								aria-hidden
								className={cn(
									TYPE.meta,
									'text-muted-foreground group-hover:text-foreground mt-3.5 inline-flex items-center gap-1.5 transition-colors',
								)}
							>
								{COURSES_FEATURED_WORKSHOP.imageLinkLabel}
								<ArrowRight className="ease-out-quart size-3.5 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none" />
							</span>
						</Link>
					) : null}
				</div>
			</div>
		</section>
	)
}
