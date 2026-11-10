import { revalidateTag } from 'next/cache'
import { log } from '@/server/logger'
import type { CouponPort } from '@coursebuilder/core/ports'

/** Call after a committed default-coupon mutation. Never fail a completed write. */
export async function invalidateDefaultCoupon() {
	try {
		revalidateTag('default-coupon', { expire: 0 })
	} catch {
		try {
			await log.warn('default_coupon.invalidation_failed')
		} catch {}
	}
}

/** There are no update/delete methods on the current CouponPort. Keep reads,
 * especially checkout reads, untouched; only wrap coupon creation.
 */
export function withDefaultCouponInvalidation<
	T extends Pick<CouponPort, 'createCoupon'>,
>(adapter: T, invalidate: () => Promise<void> = invalidateDefaultCoupon): T {
	return {
		...adapter,
		createCoupon: async (input: Parameters<T['createCoupon']>[0]) => {
			const result = await adapter.createCoupon(input)
			try {
				await invalidate()
			} catch {
				try {
					await log.warn('default_coupon.invalidation_failed')
				} catch {}
			}
			return result
		},
	}
}
