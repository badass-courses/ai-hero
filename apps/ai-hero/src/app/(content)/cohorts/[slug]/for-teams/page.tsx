import * as React from 'react'
import type { Metadata, ResolvingMetadata } from 'next'
import { notFound } from 'next/navigation'
import { CldImage } from '@/components/cld-image'
import { ForTeamsPage } from '@/components/for-teams/for-teams-page'
import { teamInvoiceBand } from '@/components/for-teams/team-invoice-band'
import { db } from '@/db'
import { purchases } from '@/db/schema'
import { env } from '@/env.mjs'
import { getCachedCohort } from '@/lib/cohorts-query'
import { teamSaleState } from '@/lib/team-invoice/sale-state'
import { compileMDX } from '@/utils/compile-mdx'
import { formatInTimeZone } from 'date-fns-tz'
import { count, eq } from 'drizzle-orm'

import { productSchema } from '@coursebuilder/core/schemas'
import { Skeleton } from '@coursebuilder/ui'

import {
	WorkshopPricingClient,
	WorkshopPricingFallback,
} from '../../../workshops/_components/workshop-pricing'
import { PublicProductPricing } from '../../../workshops/_components/workshop-public-pricing-server'

type Props = {
	params: Promise<{ slug: string }>
}

// Shorter than the workshop page's hour: whether seats are open depends on
// the enrollment window, and a page that opens late sells nothing.
export const revalidate = 600
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
	const cohort = await getCachedCohort(params.slug)

	if (!cohort?.fields.forTeamsBody) {
		return parent as Metadata
	}

	const title = `${cohort.fields.title} for your team`
	const description =
		cohort.fields.description ??
		'Team seats, invoicing and a shared way to build with AI.'

	return {
		title,
		description,
		alternates: {
			canonical: `/cohorts/${cohort.fields.slug}/for-teams`,
		},
		openGraph: {
			title,
			description,
			images: [
				{
					url:
						cohort.fields.image ||
						`${env.NEXT_PUBLIC_URL}/api/og/default?title=${encodeURIComponent(title)}`,
				},
			],
		},
	}
}

/**
 * The team story for one cohort: `/cohorts/[slug]/for-teams`. Same contract
 * as the workshop team page: the cohort's `forTeamsBody` is the story, an
 * empty body is a 404, and the shared `ForTeamsPage` owns the order.
 *
 * Seats sell here only while the cohort is on sale (published, inside its
 * enrollment window, with room). Before that the page has no checkout: the
 * invoice band takes a request and the inquiry form stays.
 */
export default async function CohortForTeamsPage(props: Props) {
	const params = await props.params
	const cohort = await getCachedCohort(params.slug)

	if (!cohort?.fields.forTeamsBody) notFound()

	const parsedProduct = productSchema.safeParse(
		cohort.resourceProducts?.[0]?.product,
	)
	const product =
		parsedProduct.success && parsedProduct.data.status === 1
			? parsedProduct.data
			: null
	const purchaseCount = product
		? await db
				.select({ count: count() })
				.from(purchases)
				.where(eq(purchases.productId, product.id))
				.then((rows) => rows[0]?.count ?? 0)
		: 0
	const now = new Date()
	const onSale = product
		? teamSaleState(product, { now, purchaseCount }).onSale
		: false

	const timezone = cohort.fields.timezone || 'America/Los_Angeles'
	const openEnrollment = product?.fields?.openEnrollment
	const opensLabel = openEnrollment
		? formatInTimeZone(new Date(openEnrollment), timezone, 'MMMM d, yyyy')
		: null

	const cohortHref = `/cohorts/${cohort.fields.slug}`
	const location = `${cohortHref}/for-teams`

	const { content: story } = await compileMDX(cohort.fields.forTeamsBody)

	return (
		<ForTeamsPage
			backHref={cohortHref}
			title={cohort.fields.title}
			description={cohort.fields.description}
			heroNote="One licence per person, each assigned from your account."
			cover={
				cohort.fields.image ? (
					<CldImage
						fill
						src={cohort.fields.image}
						alt={cohort.fields.title}
						sizes="(max-width: 768px) 100vw, 50vw"
						className="object-contain"
					/>
				) : null
			}
			story={story}
			seats={
				product && onSale ? (
					<React.Suspense
						fallback={
							<div className="flex w-full flex-col gap-2 p-5">
								<Skeleton className="bg-accent h-10 w-full" />
								<Skeleton className="bg-accent h-10 w-full" />
								<Skeleton className="bg-accent h-10 w-full" />
							</div>
						}
					>
						<PublicProductPricing productId={product.id}>
							{(pricingProps) => (
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
							)}
						</PublicProductPricing>
					</React.Suspense>
				) : null
			}
			invoice={
				product
					? teamInvoiceBand(product, { now, purchaseCount, opensLabel })
					: null
			}
			location={location}
			source={cohort.fields.slug}
		/>
	)
}
