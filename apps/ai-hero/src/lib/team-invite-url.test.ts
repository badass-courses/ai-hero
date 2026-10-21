import { describe, expect, it } from 'vitest'

import { getCouponInviteUrl, getTeamInviteUrlForPurchase } from './team-invite-url'

const baseUrl = 'https://www.aihero.dev'

describe('team invite url', () => {
	it('uses the same link format as the admin coupon table', () => {
		expect(getCouponInviteUrl('coupon-123', baseUrl)).toBe(
			'https://www.aihero.dev?code=coupon-123',
		)
	})

	it("builds the buyer's link from the purchase's bulk coupon id", () => {
		expect(
			getTeamInviteUrlForPurchase({ bulkCouponId: 'bulk-abc' }, baseUrl),
		).toBe('https://www.aihero.dev?code=bulk-abc')
	})

	it('gives seat claimers no link', () => {
		const redeemerPurchase = {
			bulkCouponId: null,
			redeemedBulkCouponId: 'bulk-abc',
		}
		expect(getTeamInviteUrlForPurchase(redeemerPurchase, baseUrl)).toBe(
			undefined,
		)
		expect(getTeamInviteUrlForPurchase({}, baseUrl)).toBe(undefined)
	})
})
