import * as React from 'react'
import type { Metadata, ResolvingMetadata } from 'next'
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
import { ArrowLeft, ArrowRight, ArrowUpRight } from 'lucide-react'

import { Skeleton } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import WorkshopImage from '../../_components/workshop-image'
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

/** The inner pad every band shares (DESIGN rules 1 and 3). */
const INNER = 'px-[18px] py-12 sm:px-11 md:py-[52px]'

const OUTLINE_BUTTON =
	'border-foreground/20 hover:bg-secondary focus-visible:ring-ring group inline-flex h-[46px] items-center justify-center gap-2 rounded-[9px] border px-5 text-[15px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2'

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
				{/* Hero: same six-column rhythm as the workshop page, the cover
				    bleeding to the container's edges on the right. The eyebrow says
				    what kind of page this is, the title names the course, and the
				    two asks sit under the lead where the workshop page has its
				    contributor. */}
				<header className="relative overflow-hidden border-b">
					<div className="relative z-10 flex w-full flex-col-reverse md:grid md:grid-cols-6 md:items-stretch">
						<div className="col-span-4 flex w-full flex-col items-start px-[18px] pb-12 pt-8 sm:px-11 md:justify-center md:py-[52px]">
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
											'inline-flex items-center gap-2',
										)}
									>
										Buy team seats
										<ArrowUpRight className="size-4" aria-hidden="true" />
									</a>
								)}
								<a href="#contact" className={OUTLINE_BUTTON}>
									Ask about team access
									<ArrowRight
										className="ease-out-quart size-4 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none"
										aria-hidden="true"
									/>
								</a>
							</div>
							<p className={cn(TYPE.metaSm, 'text-muted-foreground mt-4')}>
								One licence per person. Everyone learns on their own schedule.
							</p>
						</div>
						<div className="relative col-span-2 w-full md:border-l">
							{workshop.fields.coverImage?.url && (
								<WorkshopImage imageUrl={workshop.fields.coverImage.url} />
							)}
						</div>
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
								<a
									href="#contact"
									className={cn(
										TYPE.meta,
										'text-muted-foreground hover:text-foreground mt-6 inline-flex items-center gap-1.5 underline-offset-4 hover:underline',
									)}
								>
									Need an invoice or a bigger group? Ask about team access
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
					className="scroll-mt-(--nav-height) border-b"
				>
					<div className="grid grid-cols-1 md:grid-cols-6">
						<div className={cn('col-span-3 lg:col-span-2', INNER)}>
							<p className={cn(TYPE.groupLabel, 'mb-4')}>Talk to us</p>
							<h2 id="contact-title" className={cn(TYPE.heading)}>
								Have a question first?
							</h2>
							<p
								className={cn(
									TYPE.lead,
									'text-foreground/80 mt-5 max-w-[40ch]',
								)}
							>
								Tell us your team size and what you would like your engineers
								to learn. Invoicing, procurement and larger groups all start
								here.
							</p>
						</div>
						<div className={cn('col-span-3 md:border-l lg:col-span-4', INNER)}>
							<div className="max-w-2xl">
								<TeamInquiryForm location={location} source={params.module} />
							</div>
						</div>
					</div>
				</section>
			</main>
		</LayoutClient>
	)
}
