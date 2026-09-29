import { describe, expect, it } from 'vitest'

import { issuedRow, offerPayload } from './evergreen-offer-status.fixtures'
import {
	evergreenCouponIdOf,
	readEvergreenOfferCoupon,
} from './evergreen-offer-purchase'

const EVERGREEN = `eoj-coupon:${'c'.repeat(64)}`

describe('evergreenCouponIdOf', () => {
	it('finds the evergreen coupon a purchase redeemed', () => {
		expect(evergreenCouponIdOf({ couponId: EVERGREEN })).toBe(EVERGREEN)
		expect(
			evergreenCouponIdOf({ couponId: null, redeemedBulkCouponId: EVERGREEN }),
		).toBe(EVERGREEN)
	})

	it('ignores every other coupon, PPP and team ones included', () => {
		expect(evergreenCouponIdOf({ couponId: 'ppp-coupon' })).toBeUndefined()
		expect(
			evergreenCouponIdOf({ couponId: null, bulkCouponId: 'coupon-team' }),
		).toBeUndefined()
		expect(evergreenCouponIdOf({})).toBeUndefined()
	})
})

describe('readEvergreenOfferCoupon', () => {
	it('names the contact the coupon was issued to', async () => {
		const { row, couponId } = await issuedRow(offerPayload())
		expect(readEvergreenOfferCoupon(couponId, row)).toEqual({
			status: 'redeemed',
			redemption: { couponId, contactId: 'contact-status-fixture' },
		})
	})

	it('reads a redeemed, expired coupon: redemption is history, not availability', async () => {
		const { row, couponId } = await issuedRow(offerPayload())
		expect(
			readEvergreenOfferCoupon(couponId, { ...row, usedCount: 1, status: 0 }),
		).toMatchObject({ status: 'redeemed' })
	})

	it('refuses a missing row, a different row, or one the journey did not issue', async () => {
		const { row, couponId } = await issuedRow(offerPayload())
		expect(readEvergreenOfferCoupon(couponId, null)).toEqual({
			status: 'refused',
			couponId,
			reason: 'coupon-missing',
		})
		expect(readEvergreenOfferCoupon(EVERGREEN, row)).toEqual({
			status: 'refused',
			couponId: EVERGREEN,
			reason: 'coupon-id-mismatch',
		})
		// A row that carries the prefix but whose fields name another contact
		// does not match its own semantic id, so it cannot redirect a purchase.
		const fields = row.fields as {
			evergreenOffer: { issue: Record<string, unknown> }
		}
		const forged = {
			...row,
			fields: {
				...fields,
				evergreenOffer: {
					...fields.evergreenOffer,
					issue: { ...fields.evergreenOffer.issue, contactId: 'someone-else' },
				},
			},
		}
		expect(readEvergreenOfferCoupon(couponId, forged)).toEqual({
			status: 'refused',
			couponId,
			reason: 'coupon-contact-mismatch',
		})
	})
})
