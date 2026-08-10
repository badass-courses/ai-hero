import type { Metadata } from 'next'
import { WorkshopsIndexList } from '@/app/(content)/workshops/_components/workshops-index-list'
import { WorkshopsIndexPricing } from '@/app/(content)/workshops/_components/workshops-index-pricing'
import LayoutClient from '@/components/layout-client'
import config from '@/config'
import { db } from '@/db'
import { contentResourceProduct, contentResourceResource } from '@/db/schema'
import { env } from '@/env.mjs'
import { getPublicPricingProps } from '@/lib/pricing-query'
import { getCachedPublicWorkshops } from '@/lib/workshops-query'
import { asc } from 'drizzle-orm'

import type { ContentResource } from '@coursebuilder/core/schemas'
import { uniqBy } from '@coursebuilder/nodash'

export const revalidate = 3600
export const dynamic = 'force-static'

export const metadata: Metadata = {
	title: `AI Hero Workshops by ${config.author}`,
	openGraph: {
		images: [
			{
				url: `${env.NEXT_PUBLIC_URL}/api/og?title=${encodeURIComponent(`AI Hero Workshops by ${config.author}`)}`,
			},
		],
	},
}

export default async function Workshops() {
	const [products, publicWorkshops, pricing] = await Promise.all([
		db.query.contentResourceProduct.findMany({
			with: {
				resource: {
					with: {
						resources: {
							with: { resource: true },
							orderBy: asc(contentResourceResource.position),
						},
					},
				},
				product: true,
			},
			orderBy: asc(contentResourceProduct.position),
		}),
		getCachedPublicWorkshops(),
		getPublicPricingProps(),
	])
	const cohortWorkshops = products.flatMap((product) =>
		product.resource.resources
			.filter((resource) => resource.resource.type === 'workshop')
			.map((resource) => resource.resource),
	)
	const workshops = uniqBy(
		[...publicWorkshops, ...cohortWorkshops],
		(item) => item.id,
	) as ContentResource[]

	return (
		<LayoutClient withContainer>
			<main className="container min-h-[calc(100vh-var(--nav-height))] px-0">
				<div className="max-w-(--breakpoint-lg) mx-auto flex h-full w-full flex-col items-center">
					<div className="w-full px-5 pb-16 pt-24">
						<h1 className="font-heading text-center text-xl font-medium sm:text-3xl">
							Professional AI Workshops
						</h1>
					</div>
					<div className="relative w-full">
						<WorkshopsIndexList initialWorkshops={workshops} />
						{pricing?.allowPurchase && (
							<WorkshopsIndexPricing
								product={pricing.product}
								initialCommerceProps={pricing.commerceProps}
								pricingData={pricing.pricingData}
							/>
						)}
					</div>
				</div>
			</main>
		</LayoutClient>
	)
}
