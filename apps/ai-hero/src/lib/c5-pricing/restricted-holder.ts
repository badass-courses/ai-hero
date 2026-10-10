import { db } from '@/db'
import { purchases } from '@/db/schema'
import { and, eq } from 'drizzle-orm'

/** Whether a user holds a region-restricted purchase of a product. */
export async function holdsRestrictedPurchase(
	userId: string,
	productId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: purchases.id })
		.from(purchases)
		.where(
			and(
				eq(purchases.userId, userId),
				eq(purchases.productId, productId),
				eq(purchases.status, 'Restricted'),
			),
		)
		.limit(1)
	return Boolean(row)
}
