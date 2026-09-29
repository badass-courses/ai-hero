import { describe, expect, it, vi } from 'vitest'

import { createEvergreenOfferStatusHandler } from './evergreen-offer-status'

const couponId = `eoj-coupon:${'a'.repeat(64)}`
const get = (query: string) =>
	new Request(`https://www.aihero.dev/api/evergreen/offer-status${query}`)

describe('GET /api/evergreen/offer-status', () => {
	it('reads nothing for a missing or non-evergreen coupon id', async () => {
		const loadCoupon = vi.fn()
		const handler = createEvergreenOfferStatusHandler({
			loadCoupon,
			now: () => '2026-10-07T00:00:00.000Z',
		})
		for (const query of ['', '?coupon=site-sale', '?coupon=eoj-coupon:short']) {
			const response = await handler(get(query))
			expect(await response.json()).toEqual({ status: 'none' })
		}
		expect(loadCoupon).not.toHaveBeenCalled()
	})

	it('answers uncached, with no session, for an evergreen coupon id', async () => {
		const loadCoupon = vi.fn(async () => null)
		const handler = createEvergreenOfferStatusHandler({
			loadCoupon,
			now: () => '2026-10-07T00:00:00.000Z',
		})
		const response = await handler(
			get(`?coupon=${encodeURIComponent(couponId)}`),
		)
		expect(loadCoupon).toHaveBeenCalledWith(couponId)
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(await response.json()).toEqual({ status: 'none' })
	})
})
