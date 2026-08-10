import type { ReactNode } from 'react'
import { unstable_cache } from 'next/cache'
import { courseBuilderAdapter } from '@/db'
import { getPricingData } from '@/lib/pricing-query'
import { getProduct } from '@/lib/products-query'
import { getCachedAllWorkshopProducts } from '@/lib/workshops-query'

import { propsForCommerce } from '@coursebuilder/core/pricing/props-for-commerce'

import type { WorkshopPageProps } from './workshop-page-props'

const getPublicWorkshopPricingProps = unstable_cache(
	async (moduleSlug: string) => {
		const allProducts = await getCachedAllWorkshopProducts(moduleSlug)
		const standaloneProducts = allProducts.filter(
			(product) => product.type !== 'cohort',
		)
		const productForPricing = standaloneProducts[0] || allProducts[0] || null
		const product = productForPricing?.id
			? await getProduct(productForPricing.id)
			: null

		if (!product) return null

		const [pricingData, commerceProps] = await Promise.all([
			getPricingData({ productId: product.id }),
			propsForCommerce(
				{
					query: {},
					userId: undefined,
					products: allProducts,
					countryCode: process.env.DEFAULT_COUNTRY || 'US',
				},
				courseBuilderAdapter,
			),
		])

		return {
			availableBonuses: [],
			product,
			pricingData,
			quantityAvailable: pricingData.quantityAvailable,
			...commerceProps,
		}
	},
	['public-workshop-pricing-v1'],
	{ revalidate: 600, tags: ['workshop', 'products', 'pricing'] },
)

export async function PublicWorkshopPricing({
	moduleSlug,
	children,
}: {
	moduleSlug: string
	children: (props: WorkshopPageProps) => ReactNode
}) {
	const publicProps = await getPublicWorkshopPricingProps(moduleSlug)
	const props: WorkshopPageProps = publicProps
		? {
				...publicProps,
				pricingDataLoader: Promise.resolve(publicProps.pricingData),
			}
		: {
				availableBonuses: [],
				quantityAvailable: -1,
				pricingDataLoader: Promise.resolve({
					formattedPrice: null,
					purchaseToUpgrade: null,
					quantityAvailable: -1,
				}),
			}

	const allowPurchase = Boolean(
		props.product?.fields.state === 'published' &&
		props.product?.fields.visibility === 'public',
	)

	return children({ ...props, allowPurchase })
}
