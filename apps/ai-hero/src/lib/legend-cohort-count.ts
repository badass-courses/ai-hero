import { db } from '@/db'
import { products, purchases } from '@/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'

/** Active distinct cohort purchases a learner needs for the Legend role. */
export const LEGEND_COHORT_THRESHOLD = 3

export const countActiveDistinctCohortPurchasesForUser = async (
	userId: string,
) => {
	const [result] = await db
		.select({
			count: sql<number>`count(distinct ${purchases.productId})`,
		})
		.from(purchases)
		.innerJoin(products, eq(products.id, purchases.productId))
		.where(
			and(
				eq(purchases.userId, userId),
				inArray(purchases.status, ['Valid', 'Restricted']),
				eq(products.type, 'cohort'),
			),
		)

	return Number(result?.count ?? 0)
}

/** An unknown count (undefined) keeps the legend event, so the legend function decides. */
export const shouldSendLegendEvent = (activeCohortCount: number | undefined) =>
	activeCohortCount === undefined ||
	activeCohortCount >= LEGEND_COHORT_THRESHOLD
