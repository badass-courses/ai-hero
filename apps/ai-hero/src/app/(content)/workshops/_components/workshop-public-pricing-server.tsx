import type { ReactNode } from 'react'
import { unstable_cache } from 'next/cache'
import { courseBuilderAdapter } from '@/db'
import { getPricingData } from '@/lib/pricing-query'
import { getProduct } from '@/lib/products-query'
import { getCachedAllWorkshopProducts } from '@/lib/workshops-query'

import { propsForCommerce } from '@coursebuilder/commerce/props-for-commerce'

import type { Product } from '@coursebuilder/core/schemas'

import type { WorkshopPageProps } from './workshop-page-props'

async function publicPricingProps(
	product: Product,
	allProducts: Product[],
) {
	// Active site-wide sale for this product (e.g. the launch intro price):
	// apply it to the pricing data so PricingInline / the buy widget show the
	// discounted price, and expose the coupon so HasDiscount / DiscountDeadline
	// can gate sale copy — mirroring loadCohortPageData.
	const couponResult = await courseBuilderAdapter.getDefaultCoupon([product.id])
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
}

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

		return publicPricingProps(product, allProducts)
	},
	['public-workshop-pricing-v2'],
	{ revalidate: 600, tags: ['workshop', 'products', 'pricing'] },
)

/** One product's public pricing, for pages that are not a workshop's. */
const getPublicProductPricingProps = unstable_cache(
	async (productId: string) => {
		const product = await getProduct(productId)
		if (!product) return null
		return publicPricingProps(product, [product])
	},
	['public-product-pricing-v1'],
	{ revalidate: 600, tags: ['products', 'pricing'] },
)

export async function PublicWorkshopPricing({
	moduleSlug,
	children,
}: {
	moduleSlug: string
	children: (props: WorkshopPageProps) => ReactNode
}) {
	return renderPublicPricing(
		await getPublicWorkshopPricingProps(moduleSlug),
		children,
	)
}

/**
 * The same public pricing, by product id: the cohort team page's card, which
 * has no workshop slug to look its product up by.
 */
export async function PublicProductPricing({
	productId,
	children,
}: {
	productId: string
	children: (props: WorkshopPageProps) => ReactNode
}) {
	return renderPublicPricing(
		await getPublicProductPricingProps(productId),
		children,
	)
}

async function renderPublicPricing(
	cachedProps: Awaited<ReturnType<typeof publicPricingProps>> | null,
	children: (props: WorkshopPageProps) => ReactNode,
) {
	let publicProps = cachedProps

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
