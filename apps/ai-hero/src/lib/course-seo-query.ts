import 'server-only'
import { unstable_cache } from 'next/cache'
import { getProduct } from './products-query'
import { getSeatsTaken, seatsLeft } from './seats-taken-query'

/** Anonymous list-price facts only. Never run coupon, country, PPP, or user pricing. */
export const getCourseSeoCommerce = unstable_cache(
	async (productId: string) => {
		try {
			const product = await getProduct(productId)
			if (!product) return undefined
			const cap = product.quantityAvailable
			const quantityAvailable =
				cap === -1
					? -1
					: typeof cap === 'number' && Number.isInteger(cap) && cap >= 0
						? seatsLeft(cap, await getSeatsTaken(productId))
						: undefined
			return { product, quantityAvailable }
		} catch {
			// SEO must not turn a missing price/seat reading into either an offer or a page failure.
			return undefined
		}
	},
	['course-seo-commerce-v1'],
	{ revalidate: 600, tags: ['products', 'pricing'] },
)
