import { describe, expect, it, vi } from 'vitest'

import { ignoreEmptyCouponLookup } from './coupon-lookup'

describe('coupon lookup', () => {
	it.each([null, ''])('skips an empty coupon value (%s)', async (coupon) => {
		const lookup = vi.fn(async () => ({ id: 'coupon-1' }))
		const guardedLookup = ignoreEmptyCouponLookup(lookup)

		await expect(guardedLookup(coupon)).resolves.toBeUndefined()
		expect(lookup).not.toHaveBeenCalled()
	})

	it('loads an explicit coupon value', async () => {
		const result = { id: 'coupon-1' }
		const lookup = vi.fn(async () => result)
		const guardedLookup = ignoreEmptyCouponLookup(lookup)

		await expect(guardedLookup('coupon-1')).resolves.toBe(result)
		expect(lookup).toHaveBeenCalledOnce()
		expect(lookup).toHaveBeenCalledWith('coupon-1')
	})
})
