import * as React from 'react'
import type { Metadata, ResolvingMetadata } from 'next'
import Image from 'next/image'
import { notFound } from 'next/navigation'
import {
	FOR_TEAMS_INNER,
	ForTeamsPage,
} from '@/components/for-teams/for-teams-page'
import { teamInvoiceBand } from '@/components/for-teams/team-invoice-band'
import { TYPE } from '@/components/landing/type'
import { env } from '@/env.mjs'
import {
	getCachedMinimalWorkshop,
	getCachedWorkshopProduct,
} from '@/lib/workshops-query'
import { compileMDX } from '@/utils/compile-mdx'

import { Skeleton } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

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
 * The team story for one workshop: `/workshops/[module]/for-teams`. The
 * shared `ForTeamsPage` owns the order; this adapter supplies the workshop's
 * cover, story, team pricing card and invoice band.
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
		<ForTeamsPage
			backHref={workshopHref}
			title={workshop.fields.title}
			description={workshop.fields.description}
			cover={
				workshop.fields.coverImage?.url ? (
					<Image
						priority
						fill
						src={workshop.fields.coverImage.url}
						alt={workshop.fields.coverImage.alt ?? workshop.fields.title}
						sizes="(max-width: 768px) 100vw, 50vw"
						className="object-contain"
					/>
				) : null
			}
			story={story}
			seats={
				sellsSeats ? (
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
												className="bg-card pb-8"
												teamMode
												{...pricingProps}
											/>
										}
									>
										<WorkshopPricingClient
											className="bg-card pb-8"
											teamMode
											{...pricingProps}
										/>
									</React.Suspense>
								) : (
									<div className={cn('flex flex-col gap-3', FOR_TEAMS_INNER)}>
										<p className={cn(TYPE.subhead)}>
											Team seats open with the course.
										</p>
										<p className={cn(TYPE.meta, 'text-muted-foreground')}>
											Get a quote below and we will let you know the moment
											seats are on sale.
										</p>
									</div>
								)
							}
						</PublicWorkshopPricing>
					</React.Suspense>
				) : null
			}
			invoice={sellsSeats && product ? teamInvoiceBand(product) : null}
			location={location}
			source={params.module}
		/>
	)
}
