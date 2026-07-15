import { unstable_cache } from 'next/cache'
import { db } from '@/db'
import { products, purchases } from '@/db/schema'
import { and, count, eq, inArray } from 'drizzle-orm'

/**
 * Total paid cohort seats across every cohort to date — the "engineers
 * trained" stat on /courses. Counts Valid + Restricted purchases (Restricted
 * = regional-pricing seats; those students joined too) and excludes
 * refunds/disputes/bans. Cached 1h; purchases have no revalidation tag, and
 * a stat this size moves slowly.
 */
export const getCachedCohortAlumniCount = unstable_cache(
	async (): Promise<number> => {
		const rows = await db
			.select({ count: count() })
			.from(purchases)
			.innerJoin(products, eq(products.id, purchases.productId))
			.where(
				and(
					eq(products.type, 'cohort'),
					inArray(purchases.status, ['Valid', 'Restricted']),
				),
			)
		return rows[0]?.count ?? 0
	},
	['cohort-alumni-count-v1'],
	{ revalidate: 3600 },
)

/**
 * Conservative display rounding: floor to the nearest 500 with a "+"
 * (8,763 → "8,500+"), so the claim is always true and never oversold.
 * Returns null below 1,000 — a small number reads worse than no number.
 */
export function formatAlumniCount(total: number): string | null {
	if (total < 1000) return null
	const floored = Math.floor(total / 500) * 500
	return `${floored.toLocaleString('en-US')}+`
}
