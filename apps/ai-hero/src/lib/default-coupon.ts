import { unstable_cache } from 'next/cache'
import { courseBuilderAdapter } from '@/db'

type DefaultCoupon = Awaited<
	ReturnType<typeof courseBuilderAdapter.getDefaultCoupon>
>
export const DEFAULT_COUPON_REVALIDATE_SECONDS = 30

/** Display only. Checkout continues to use the adapter's fresh reads. */
export async function getCachedDefaultCoupon(
	productIds?: string[],
): Promise<DefaultCoupon> {
	// Preserve undefined vs [] and normalize set ordering for the cache key.
	const ids = productIds ? [...new Set(productIds)].sort() : undefined
	const cached = await unstable_cache(
		async () => {
			const cachedAt = Date.now()
			return {
				result: await courseBuilderAdapter.getDefaultCoupon(ids),
				cachedAt,
			}
		},
		['default-coupon', JSON.stringify(ids) ?? 'all'],
		{ tags: ['default-coupon'], revalidate: DEFAULT_COUPON_REVALIDATE_SECONDS },
	)()
	const result = cached.result
	const now = Date.now()
	// Next's stale-while-revalidate must not extend the display's TTL or expiry.
	if (
		now - cached.cachedAt >= DEFAULT_COUPON_REVALIDATE_SECONDS * 1000 ||
		(result?.defaultCoupon.expires &&
			new Date(result.defaultCoupon.expires).getTime() <= now)
	) {
		return courseBuilderAdapter.getDefaultCoupon(ids)
	}
	if (!result) return null
	// unstable_cache serializes Dates. Preserve the adapter's public date types.
	return {
		...result,
		defaultCoupon: {
			...result.defaultCoupon,
			createdAt: result.defaultCoupon.createdAt
				? new Date(result.defaultCoupon.createdAt)
				: null,
			expires: result.defaultCoupon.expires
				? new Date(result.defaultCoupon.expires)
				: null,
		},
	}
}
