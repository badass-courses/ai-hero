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

		// Active site-wide sale for this product (e.g. the launch intro price):
		// apply it to the pricing data so PricingInline / the buy widget show the
		// discounted price, and expose the coupon so HasDiscount / DiscountDeadline
		// can gate sale copy — mirroring loadCohortPageData.
		const couponResult = await courseBuilderAdapter.getDefaultCoupon([
			product.id,
		])
		const defaultCoupon = couponResult?.defaultCoupon ?? null

		const [pricingData, commerceProps] = await Promise.all([
			getPricingData({
				productId: product.id,
				...(defaultCoupon?.merchantCouponId
					? {
							merchantCouponId: defaultCoupon.merchantCouponId,
							usedCouponId: defaultCoupon.id,
						}
					: {}),
			}),
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
			...(defaultCoupon ? { defaultCoupon } : {}),
		}
	},
	['public-workshop-pricing-v2'],
	{ revalidate: 600, tags: ['workshop', 'products', 'pricing'] },
)

export async function PublicWorkshopPricing({
	moduleSlug,
	children,
}: {
	moduleSlug: string
	children: (props: WorkshopPageProps) => ReactNode
}) {
	let publicProps = await getPublicWorkshopPricingProps(moduleSlug)

	// The cached entry can outlive the coupon by up to its revalidate window.
	// If the sale ended in the meantime, drop the coupon and reprice without it
	// so HasDiscount copy and the widget never advertise an expired price.
	if (
		publicProps?.defaultCoupon?.expires &&
		new Date(publicProps.defaultCoupon.expires) < new Date()
	) {
		const { defaultCoupon: _expired, ...rest } = publicProps
		publicProps = {
			...rest,
			pricingData: await getPricingData({ productId: rest.product.id }),
		}
	}

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
