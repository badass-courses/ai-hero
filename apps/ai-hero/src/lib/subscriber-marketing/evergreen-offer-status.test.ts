import { describe, expect, it } from 'vitest'

import {
	EVERGREEN_OFFER_FIELD_KEYS,
	offerFieldsFor,
} from './drovr-evergreen-coupon'
import type { CommerceCouponRow } from './evergreen-offer-journey/coupon-authority'
import { issuedRow, offerPayload } from './evergreen-offer-status.fixtures'
import {
	evergreenOfferEndedText,
	evergreenOfferStatus,
	isEvergreenCouponId,
} from './evergreen-offer-status'

describe('evergreenOfferStatus', () => {
	it('page == field: the ended notice prints the Kit field string for the same coupon', async () => {
		for (const issue of [
			offerPayload(),
			offerPayload({
				expiresAt: '2026-10-06T06:59:59.000Z',
				timezone: 'America/Los_Angeles',
				timezoneSource: 'fallback',
			}),
			offerPayload({ expiresAt: '2026-10-05T12:59:59.000Z', timezone: 'Australia/Sydney' }),
		]) {
			const { row, couponId } = await issuedRow(issue)
			const field = offerFieldsFor({
				couponId,
				payload: issue,
				origin: 'https://www.aihero.dev',
				deadlineFormat: 'absolute',
			})[EVERGREEN_OFFER_FIELD_KEYS.deadlineDisplay]
			expect(evergreenOfferStatus(row, '2026-10-07T00:00:00.000Z')).toEqual({
				status: 'ended',
				deadline: field,
			})
		}
	})

	it('names the zone and, for a fallback, the UTC equivalent', async () => {
		const berlin = await issuedRow(offerPayload())
		const fallback = await issuedRow(
			offerPayload({
				expiresAt: '2026-10-06T06:59:59.000Z',
				timezone: 'America/Los_Angeles',
				timezoneSource: 'fallback',
			}),
		)
		const text = (row: CommerceCouponRow) => {
			const status = evergreenOfferStatus(row, '2026-10-07T00:00:00.000Z')
			if (status.status !== 'ended') throw new Error('expected ended')
			return evergreenOfferEndedText(status.deadline)
		}
		expect(text(berlin.row)).toBe(
			'This private offer ended Monday, October 5, 2026 at 11:59 PM Central European Summer Time.',
		)
		expect(text(fallback.row)).toBe(
			"This private offer ended Monday, October 5, 2026 at 11:59 PM Pacific Daylight Time (that's Tuesday, October 6 at 6:59 AM UTC).",
		)
	})

	it('says nothing while the offer is open, at the exact expiry it has ended', async () => {
		const { row } = await issuedRow(offerPayload())
		expect(evergreenOfferStatus(row, '2026-10-05T21:59:58.999Z')).toEqual({
			status: 'open',
		})
		expect(evergreenOfferStatus(row, '2026-10-05T21:59:59.000Z').status).toBe(
			'ended',
		)
	})

	it('fails closed on an unreadable clock: none, never ended', async () => {
		const { row } = await issuedRow(offerPayload())
		expect(evergreenOfferStatus(row, 'not-a-date')).toEqual({ status: 'none' })
	})

	it('says nothing for a missing row or a coupon the journey does not own', async () => {
		const { row } = await issuedRow(offerPayload())
		expect(evergreenOfferStatus(null, '2026-10-07T00:00:00.000Z')).toEqual({
			status: 'none',
		})
		expect(
			evergreenOfferStatus({ ...row, fields: {} }, '2026-10-07T00:00:00.000Z'),
		).toEqual({ status: 'none' })
		expect(
			evergreenOfferStatus(
				{ ...row, amountDiscount: 5_000 },
				'2026-10-07T00:00:00.000Z',
			),
		).toEqual({ status: 'none' })
	})
})

describe('isEvergreenCouponId', () => {
	it('accepts only the semantic evergreen coupon id', async () => {
		const { couponId } = await issuedRow(offerPayload())
		expect(isEvergreenCouponId(couponId)).toBe(true)
		expect(isEvergreenCouponId('eoj-coupon:abc')).toBe(false)
		expect(isEvergreenCouponId('some-site-coupon')).toBe(false)
		expect(isEvergreenCouponId(null)).toBe(false)
	})
})
