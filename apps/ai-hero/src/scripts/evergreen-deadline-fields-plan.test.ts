import { describe, expect, it } from 'vitest'

import { offerPayload } from '@/lib/subscriber-marketing/evergreen-offer-status.fixtures'

import { planDeadlineFieldRewrite } from './evergreen-deadline-fields-plan'

const row = (offer: unknown, status = 'completed') => ({
	status,
	metadata: { offer, couponId: 'eoj-coupon:fixture' },
})

describe('planDeadlineFieldRewrite', () => {
	it('plans only open coupons: same instant, the absolute text', () => {
		const plan = planDeadlineFieldRewrite(
			[
				row(offerPayload()),
				row(
					offerPayload({
						expiresAt: '2026-10-06T06:59:59.000Z',
						timezone: 'America/Los_Angeles',
						timezoneSource: 'fallback',
					}),
				),
				row(offerPayload({ expiresAt: '2026-09-29T06:59:59.000Z' })),
				row({ not: 'an offer' }),
			],
			'2026-10-01T00:00:00.000Z',
		)

		expect(plan.open).toBe(2)
		expect(plan.skipped).toEqual({ expired: 1, invalid: 1 })
		expect(plan.byZone).toEqual({
			'Europe/Berlin (vercel-header)': 1,
			'America/Los_Angeles (fallback)': 1,
		})
		expect(plan.samples[1]).toEqual({
			zone: 'America/Los_Angeles',
			source: 'fallback',
			before: 'Monday, October 5, 2026 at 11:59 PM PDT',
			after: {
				aih_evergreen_deadline_display:
					"Monday, October 5, 2026 at 11:59 PM Pacific Daylight Time (that's Tuesday, October 6 at 6:59 AM UTC)",
				aih_evergreen_deadline_short: 'Mon Oct 5, 11:59 PM PDT',
			},
		})
	})
})
