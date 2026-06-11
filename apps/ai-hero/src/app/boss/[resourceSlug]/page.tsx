import type { Metadata, ResolvingMetadata } from 'next'
import { notFound } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { DiscountCountdown } from '@/components/mdx/mdx-components'
import { DiscountDeadline } from '@/components/pricing/discount-deadline'
import { courseBuilderAdapter } from '@/db'
import { env } from '@/env.mjs'
import { getCachedCohort } from '@/lib/cohorts-query'
import { getPage } from '@/lib/pages-query'
import { compileMDX } from '@/utils/compile-mdx'
import { formatDiscount } from '@/utils/discount-formatter'

import BossLetterArticle from './components/boss-letter-article'

const GENERIC_SLUG = 'boss-letter'

async function getPageWithFallback(resourceSlug: string) {
	const productPage = await getPage(`boss-${resourceSlug}`)
	if (productPage?.fields?.body) return productPage
	return getPage(GENERIC_SLUG)
}

async function getCohortDiscountData(resourceSlug: string) {
	const cohort = await getCachedCohort(resourceSlug)
	if (!cohort) return null

	const rawProduct = cohort.resourceProducts?.[0]?.product
	if (!rawProduct?.id) return null

	const couponResult = await courseBuilderAdapter.getDefaultCoupon([
		rawProduct.id,
	])
	return couponResult?.defaultCoupon ?? null
}

export async function generateMetadata(
	props: { params: Promise<{ resourceSlug: string }> },
	parent: ResolvingMetadata,
): Promise<Metadata> {
	const params = await props.params
	const page = await getPageWithFallback(params.resourceSlug)

	if (!page) {
		return parent as Metadata
	}

	return {
		title: page.fields.title,
		description: page.fields.description,
		openGraph: {
			title: page.fields.title,
			description: page.fields.description,
			images: [
				{
					url: `${env.NEXT_PUBLIC_URL}/api/og/default?title=${encodeURIComponent(page.fields.title || 'Invest in your team')}`,
				},
			],
		},
	}
}

export default async function BossPage(props: {
	params: Promise<{ resourceSlug: string }>
}) {
	const params = await props.params
	const page = await getPageWithFallback(params.resourceSlug)

	if (!page || !page.fields?.body) {
		return notFound()
	}

	const defaultCoupon = await getCohortDiscountData(params.resourceSlug)

	const { content } = await compileMDX(
		page.fields.body || '',
		{
			HasDiscount: ({
				children,
				fallback,
			}: {
				children: React.ReactNode
				fallback?: React.ReactNode
			}) => {
				return defaultCoupon ? (
					<>{children}</>
				) : fallback ? (
					<>{fallback}</>
				) : null
			},
			DiscountCountdown: () => {
				return defaultCoupon?.expires ? (
					<DiscountCountdown date={new Date(defaultCoupon.expires)} />
				) : null
			},
			DiscountDeadline: ({ format }: { format?: 'short' | 'long' }) => (
				<DiscountDeadline
					format={format}
					expires={defaultCoupon?.expires ?? null}
				/>
			),
		},
		{
			scope: defaultCoupon
				? {
						percentOff: parseFloat(
							(Number(defaultCoupon.percentageDiscount) * 100).toFixed(1),
						),
						discountFormatted: formatDiscount(defaultCoupon),
					}
				: {
						percentOff: null,
						discountFormatted: null,
					},
		},
	)

	return (
		<LayoutClient withContainer>
			<main className="py-10 sm:py-16">
				<div className="mb-10 flex flex-col items-center justify-center gap-2">
					<h1 className="font-heading w-full text-center text-3xl font-bold lg:text-4xl">
						{page.fields.title}
					</h1>
					<h2 className="font-heading text-primary w-full text-center text-lg font-medium lg:text-xl">
						Copy and paste this letter and send it to your boss.
					</h2>
				</div>
				<BossLetterArticle>{content}</BossLetterArticle>
			</main>
		</LayoutClient>
	)
}
