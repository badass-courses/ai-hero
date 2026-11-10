import { db } from '@/db'
import {
	contentResource,
	contentResourceProduct,
	products,
	purchases,
} from '@/db/schema'
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'

import { fieldsText, readJsonString } from './course-resources'
import type { OfferStore } from './offers'

/** The purchase statuses the C5 hook treats as holding the product. */
const HELD = ['Valid', 'Restricted']

export const offerStore: OfferStore = {
	holds: async (userId, productId) => {
		const [row] = await db
			.select({ id: purchases.id })
			.from(purchases)
			.where(
				and(
					eq(purchases.userId, userId),
					eq(purchases.productId, productId),
					// A bulk order buys seats for others; a seat the buyer redeemed is
					// its own purchase row.
					isNull(purchases.bulkCouponId),
					inArray(purchases.status, HELD),
				),
			)
			.limit(1)
		return Boolean(row)
	},
	boughtSeats: async (userId) => {
		const [row] = await db
			.select({ id: purchases.id })
			.from(purchases)
			.where(
				and(
					eq(purchases.userId, userId),
					isNotNull(purchases.bulkCouponId),
					inArray(purchases.status, HELD),
				),
			)
			.limit(1)
		return Boolean(row)
	},
	/** The cohort the product sells names it; the product row is the fallback. */
	product: async (productId) => {
		const [[product], [cohort]] = await Promise.all([
			db
				.select({ name: products.name })
				.from(products)
				.where(eq(products.id, productId))
				.limit(1),
			db
				.select({ slug: fieldsText('slug'), title: fieldsText('title') })
				.from(contentResourceProduct)
				.innerJoin(
					contentResource,
					eq(contentResource.id, contentResourceProduct.resourceId),
				)
				.where(
					and(
						eq(contentResourceProduct.productId, productId),
						eq(contentResource.type, 'cohort'),
						isNull(contentResource.deletedAt),
					),
				)
				.limit(1),
		])
		if (!product) return null
		return {
			title: readJsonString(cohort?.title) ?? product.name,
			courseSlug: readJsonString(cohort?.slug),
		}
	},
}
