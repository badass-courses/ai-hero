import {
	evergreenOfferStatus,
	isEvergreenCouponId,
	type EvergreenOfferStatus,
} from '@/lib/subscriber-marketing/evergreen-offer-status'
import type { CommerceCouponRow } from '@/lib/subscriber-marketing/evergreen-offer-journey/coupon-authority'

/**
 * GET /api/evergreen/offer-status?coupon=<site coupon id>. Public: the offer
 * page asks it signed out, as the email's recipient first sees the page.
 * Anything but an evergreen coupon id answers `none` without a read.
 */
export function createEvergreenOfferStatusHandler(deps: {
	loadCoupon: (id: string) => Promise<CommerceCouponRow | null>
	now: () => string
}) {
	return async (request: Request): Promise<Response> => {
		const couponId = new URL(request.url).searchParams.get('coupon')
		const body: EvergreenOfferStatus = isEvergreenCouponId(couponId)
			? evergreenOfferStatus(await deps.loadCoupon(couponId!), deps.now())
			: { status: 'none' }
		return Response.json(body, {
			headers: { 'cache-control': 'no-store' },
		})
	}
}

export const evergreenOfferStatusHandler = createEvergreenOfferStatusHandler({
	loadCoupon: async (id) => {
		const { db } = await import('@/db')
		const { coupon } = await import('@/db/schema')
		const { eq } = await import('drizzle-orm')
		const [row] = await db.select().from(coupon).where(eq(coupon.id, id)).limit(1)
		return row ?? null
	},
	now: () => new Date().toISOString(),
})
