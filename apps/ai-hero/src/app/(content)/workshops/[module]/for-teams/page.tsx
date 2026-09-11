import * as React from 'react'
import type { Metadata, ResolvingMetadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { CompanyLogoGrid } from '@/components/landing/company-logo-grid'
import { BADGE_NEUTRAL, TYPE } from '@/components/landing/type'
import LayoutClient from '@/components/layout-client'
import { TeamInquiryForm } from '@/components/team-inquiry/team-inquiry-form'
import { env } from '@/env.mjs'
import {
	getCachedMinimalWorkshop,
	getCachedWorkshopProduct,
} from '@/lib/workshops-query'
import { compileMDX } from '@/utils/compile-mdx'
import {
	ArrowLeft,
	ArrowRight,
	Percent,
	Receipt,
	User,
} from 'lucide-react'

import { Skeleton } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { WORKSHOP_CTA_BUTTON } from '../../_components/workshop-cta-button'
import {
	WorkshopPricingClient,
	WorkshopPricingFallback,
} from '../../_components/workshop-pricing'
import { PublicWorkshopPricing } from '../../_components/workshop-public-pricing-server'

type Props = {
	params: Promise<{ module: string }>
}

export const revalidate = 3600
export const dynamicParams = true
export const dynamic = 'force-static'

export async function generateStaticParams() {
	return []
}

/** What a seat is, for the person deciding how many to buy. */
const SEAT_FACTS = [
	{ icon: User, text: 'One licence per engineer, yours to assign from your account' },
	{ icon: Percent, text: 'Volume pricing from five seats, applied in the card' },
	{ icon: Receipt, text: 'Invoice with your company details and tax ID after checkout' },
] as const

/** The inner pad every band shares (DESIGN rules 1 and 3). */
const INNER = 'px-[18px] py-12 sm:px-11 md:py-[52px]'

const OUTLINE_BUTTON =
	'border-foreground/20 hover:bg-secondary focus-visible:ring-ring inline-flex h-[46px] items-center justify-center rounded-[9px] border px-5 text-[15px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2'

export async function generateMetadata(
	props: Props,
	parent: ResolvingMetadata,
): Promise<Metadata> {
	const params = await props.params
	const workshop = await getCachedMinimalWorkshop(params.module)

	if (!workshop?.fields.forTeamsBody) {
		return parent as Metadata
	}

	const title = `${workshop.fields.title} for your team`
	const description =
		workshop.fields.description ??
		'Team seats, invoicing and a shared way to build with AI.'

	return {
		title,
		description,
		alternates: {
			canonical: `/workshops/${params.module}/for-teams`,
		},
		openGraph: {
			title,
			description,
			images: [
				{
					url:
						workshop.fields.coverImage?.url ||
						`${env.NEXT_PUBLIC_URL}/api/og/default?title=${encodeURIComponent(title)}`,
				},
			],
		},
	}
}

/**
 * The team story for one workshop: `/workshops/[module]/for-teams`.
 *
 * The page owns the order — hero, the authored story, proof, seats, contact —
 * and the workshop's `forTeamsBody` supplies everything between the hero and
 * the proof. The two things a champion came to do, buy seats or ask a
 * question, are anchors in the hero and sections at the end, so the page
 * reads top to bottom as pitch, then action.
 *
 * No body, no page: a 404 rather than an empty shell, the same contract the
 * skills team page keeps, because nothing alerts on a chrome-only 200.
 */
export default async function WorkshopForTeamsPage(props: Props) {
	const params = await props.params
	const workshop = await getCachedMinimalWorkshop(params.module)

	if (!workshop?.fields.forTeamsBody) notFound()

	const product = await getCachedWorkshopProduct(params.module)
	const sellsSeats = product?.type === 'self-paced'
	const workshopHref = `/workshops/${params.module}`
	const location = `${workshopHref}/for-teams`

	const { content: story } = await compileMDX(workshop.fields.forTeamsBody)

	return (
		<LayoutClient withContainer>
			<main className="flex min-h-screen w-full flex-col">
				{/* Hero: a balanced editorial split (DESIGN rule 4), the cover at
				    its own 16:9 on the right. The cover is a card with the title
				    drawn into it, so it is never cropped: it sits on the column's
				    ground at the gutter, not stretched to fill it. */}
				<header className="relative overflow-hidden border-b">
					<div className="relative z-10 grid grid-cols-1 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
						<div className="flex w-full flex-col items-start px-[18px] pb-12 pt-8 sm:px-11 md:justify-center md:py-[52px]">
							<Link
								href={workshopHref}
								className={cn(
									TYPE.metaSm,
									'text-muted-foreground hover:text-foreground mb-6 inline-flex items-center gap-1.5 transition-colors',
								)}
							>
								<ArrowLeft className="size-3.5" aria-hidden="true" />
								{workshop.fields.title}
							</Link>
							<span className={cn(TYPE.badge, BADGE_NEUTRAL, 'mb-5')}>
								For teams
							</span>
							<h1 className={cn(TYPE.title, 'max-w-[18ch] text-balance')}>
								{workshop.fields.title} for your team
							</h1>
							{workshop.fields.description && (
								<p
									className={cn(
										TYPE.lead,
										'text-foreground/80 mt-5 max-w-[60ch] text-balance',
									)}
								>
									{workshop.fields.description}
								</p>
							)}
							<div className="mt-8 flex flex-wrap items-center gap-3">
								{sellsSeats && (
									<a
										href="#seats"
										className={cn(
											WORKSHOP_CTA_BUTTON,
											'inline-flex items-center',
										)}
									>
										Buy team seats
									</a>
								)}
								{/* Both asks stay on this page, so neither wears an arrow. */}
								<a href="#contact" className={OUTLINE_BUTTON}>
									Ask about team access
								</a>
							</div>
							<p className={cn(TYPE.metaSm, 'text-muted-foreground mt-4')}>
								One licence per person. Everyone learns on their own schedule.
							</p>
						</div>
						{workshop.fields.coverImage?.url && (
							<div className="flex items-center px-[18px] pb-8 pt-8 sm:px-11 md:border-l md:py-[52px]">
								<div className="relative aspect-video w-full overflow-hidden rounded-[9px]">
									<Image
										priority
										fill
										src={workshop.fields.coverImage.url}
										alt={workshop.fields.coverImage.alt ?? workshop.fields.title}
										sizes="(max-width: 768px) 100vw, 50vw"
										className="object-contain"
									/>
								</div>
							</div>
						)}
					</div>
					<div className="absolute right-0 top-0 z-0 w-full">
						<div
							className="bg-stripes opacity-8! h-[320px] w-full"
							aria-hidden="true"
						/>
						<div
							className="to-background via-background bg-linear-to-bl absolute left-0 top-0 z-10 h-full w-full from-transparent"
							aria-hidden="true"
						/>
					</div>
				</header>

				{/* The authored story. Prose at the article measure, the same
				    typography the workshop's own body gets. */}
				<section className="border-b">
					<article
						className={cn(
							'prose dark:prose-invert sm:prose-lg prose-headings:tracking-tight prose-p:max-w-4xl prose-headings:max-w-4xl prose-ul:max-w-4xl prose-ol:max-w-4xl max-w-none',
							INNER,
						)}
					>
						{story}
					</article>
				</section>

				<section className="border-b">
					<CompanyLogoGrid className="pt-8" />
				</section>

				{/* Seats: the same pricing card the workshop sidebar shows, booted in
				    team mode so the stepper, per-seat price, coupons and sold-out
				    states are the ones checkout already trusts. */}
				{sellsSeats && (
					<section
						id="seats"
						aria-labelledby="seats-title"
						className="scroll-mt-(--nav-height) border-b"
					>
						<div className="grid grid-cols-1 md:grid-cols-6">
							<div
								className={cn(
									'col-span-3 flex flex-col justify-center lg:col-span-4',
									INNER,
								)}
							>
								<p className={cn(TYPE.groupLabel, 'mb-4')}>Self-serve</p>
								<h2 id="seats-title" className={cn(TYPE.heading, 'max-w-[20ch]')}>
									Bring the course to your team.
								</h2>
								<p
									className={cn(
										TYPE.lead,
										'text-foreground/80 mt-5 max-w-[52ch]',
									)}
								>
									Choose how many seats you need and buy online. Every seat
									is a full licence, and you assign them from your account
									whenever you are ready.
								</p>
								<ul className="mt-8 flex max-w-[52ch] flex-col">
									{SEAT_FACTS.map(({ icon: Icon, text }) => (
										<li
											key={text}
											className={cn(
												TYPE.meta,
												'flex items-center gap-3 border-t border-[color:var(--ah-line-soft)] py-3 font-normal last:border-b',
											)}
										>
											<span className="border-border bg-background flex size-9 shrink-0 items-center justify-center rounded-[6px] border text-[color:var(--ah-fg-muted)]">
												<Icon className="size-4" aria-hidden="true" />
											</span>
											{text}
										</li>
									))}
								</ul>
								<a
									href="#contact"
									className={cn(
										TYPE.meta,
										'text-muted-foreground hover:text-foreground mt-6 inline-flex items-center gap-1.5 underline-offset-4 hover:underline',
									)}
								>
									Need an invoice up front or a bigger group? Ask about team access
									<ArrowRight className="size-3.5" aria-hidden="true" />
								</a>
							</div>
							<div className="col-span-3 flex flex-col md:border-l lg:col-span-2">
								<React.Suspense
									fallback={
										<div className="flex w-full flex-col gap-2 p-5">
											<Skeleton className="bg-accent h-10 w-full" />
											<Skeleton className="bg-accent h-10 w-full" />
											<Skeleton className="bg-accent h-10 w-full" />
										</div>
									}
								>
									<PublicWorkshopPricing moduleSlug={params.module}>
										{(pricingProps) =>
											pricingProps.allowPurchase ? (
												<React.Suspense
													fallback={
														<WorkshopPricingFallback
															className="bg-card"
															teamMode
															{...pricingProps}
														/>
													}
												>
													<WorkshopPricingClient
														className="bg-card"
														teamMode
														{...pricingProps}
													/>
												</React.Suspense>
											) : (
												<div className={cn('flex flex-col gap-3', INNER)}>
													<p className={cn(TYPE.subhead)}>
														Team seats open with the course.
													</p>
													<p className={cn(TYPE.meta, 'text-muted-foreground')}>
														Ask about team access below and we will let you know
														the moment seats are on sale.
													</p>
												</div>
											)
										}
									</PublicWorkshopPricing>
								</React.Suspense>
							</div>
						</div>
					</section>
				)}

				{/* Contact: the same inquiry that /for-your-team takes, tagged with
				    this workshop so the reply can start from the right product. */}
				<section
					id="contact"
					aria-labelledby="contact-title"
					className="scroll-mt-(--nav-height)"
				>
					<div className="grid grid-cols-1 md:grid-cols-6">
						<div className={cn('col-span-3 lg:col-span-2', INNER)}>
							<p className={cn(TYPE.groupLabel, 'mb-4')}>Team pricing</p>
							<h2 id="contact-title" className={cn(TYPE.heading)}>
								Get a quote for your team
							</h2>
							<p
								className={cn(
									TYPE.lead,
									'text-foreground/80 mt-5 max-w-[40ch]',
								)}
							>
								Bigger group, an invoice before payment, or a question the
								page did not answer? Tell us how many engineers and what you
								want them to improve. You get pricing and the fastest way to
								get everyone started, within a working day.
							</p>
						</div>
						<div className={cn('col-span-3 md:border-l lg:col-span-4', INNER)}>
							<div>
								<TeamInquiryForm location={location} source={params.module} />
							</div>
						</div>
					</div>
				</section>
			</main>
		</LayoutClient>
	)
}
