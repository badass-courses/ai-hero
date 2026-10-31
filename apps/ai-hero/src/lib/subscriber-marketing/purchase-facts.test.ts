import { describe, expect, it } from 'vitest'
import {
	capturedChargeFacts,
	purchaseFacts,
	purchaseRefundFacts,
	PurchaseFactsSchema,
} from './purchase-facts'

const charge = {
	paid: true,
	captured: true,
	status: 'succeeded',
	amount_captured: 10465,
	currency: 'usd',
}
const purchase = {
	purchaseId: 'purchase-1',
	productId: 'product-ma254',
	status: 'Valid',
	charge,
}

describe('purchase facts boundary', () => {
	it('decodes old missing optional facts as unknown, not zero/full', () => {
		expect(PurchaseFactsSchema.parse({})).toEqual({})
		expect(purchaseFacts({ ...purchase, charge: undefined })).toEqual({
			purchaseId: 'purchase-1',
		})
	})
	it('uses actual captured cents, not intended charge or rounded database totals', () => {
		expect(capturedChargeFacts({ ...charge, amount: 10500 })).toEqual({
			amountCents: 10465,
			currency: 'usd',
		})
	})
	it('excludes unpaid, failed, pending, uncaptured and malformed money', () => {
		for (const override of [
			{ paid: false },
			{ captured: false },
			{ status: 'failed' },
			{ status: 'pending' },
			{ amount_captured: -1 },
			{ amount_captured: 104.65 },
			{ amount_captured: Number.MAX_SAFE_INTEGER + 1 },
			{ currency: undefined },
		]) {
			expect(capturedChargeFacts({ ...charge, ...override })).toBeUndefined()
		}
	})
	it('keeps paid team before coupon before PPP before known full price', () => {
		expect(
			purchaseFacts({
				...purchase,
				bulkCouponId: 'team-1',
				couponId: 'coupon-1',
				status: 'Restricted',
			}).priceClass,
		).toBe('team')
		expect(
			purchaseFacts({ ...purchase, couponId: 'coupon-1', status: 'Restricted' })
				.priceClass,
		).toBe('coupon')
		expect(
			purchaseFacts({ ...purchase, status: 'Restricted' }).priceClass,
		).toBe('ppp')
		expect(
			purchaseFacts({
				...purchase,
				charge: { ...charge, amount_captured: 29900 },
			}).priceClass,
		).toBe('full')
	})
	it('never forces unknown discounted/refunded/non-USD/non-target purchases full', () => {
		expect(purchaseFacts(purchase)).not.toHaveProperty('priceClass')
		expect(
			purchaseFacts({ ...purchase, status: 'Refunded' }),
		).not.toHaveProperty('priceClass')
		expect(
			purchaseFacts({
				...purchase,
				charge: { ...charge, amount_captured: 29900, currency: 'eur' },
			}),
		).not.toHaveProperty('priceClass')
		expect(
			purchaseFacts({
				...purchase,
				productId: 'other-product',
				charge: { ...charge, amount_captured: 29900 },
			}),
		).not.toHaveProperty('priceClass')
	})
	it('omits nonpaying seats even if their parent charge/coupon is supplied', () => {
		expect(
			purchaseFacts({
				...purchase,
				redeemedBulkCouponId: 'seat-1',
				bulkCouponId: 'team-1',
				couponId: 'coupon-1',
			}),
		).toEqual({ purchaseId: 'purchase-1', couponId: 'coupon-1' })
		expect(
			purchaseFacts({ ...purchase, charge: { ...charge, amount_captured: 0 } }),
		).not.toHaveProperty('priceClass')
	})
	it('carries validated coupon recipient/timestamps separately from buyer identity', () => {
		expect(
			purchaseFacts({
				...purchase,
				evergreenOffer: {
					contactId: 'offer-contact',
					issuedAt: '2026-09-24T00:00:00Z',
					expiresAt: '2026-09-29T00:00:00Z',
				},
			}),
		).toMatchObject({
			couponIssueContactId: 'offer-contact',
			couponIssuedAt: '2026-09-24T00:00:00Z',
			couponExpiresAt: '2026-09-29T00:00:00Z',
		})
	})
})

describe('individual refund facts', () => {
	const refund = {
		id: 're_1',
		status: 'succeeded',
		amount: 1995,
		currency: 'usd',
		created: 1790812800,
	}
	it('records individual succeeded delta, stable ID and provider creation time', () => {
		expect(purchaseRefundFacts({ purchaseId: 'purchase-1', refund })).toEqual({
			facts: {
				purchaseId: 'purchase-1',
				refundId: 're_1',
				amountCents: 1995,
				currency: 'usd',
			},
			occurredAt: new Date(refund.created * 1000).toISOString(),
		})
	})
	it('does not treat failed/pending/invalid refunds as zero refunds', () => {
		for (const override of [
			{ status: 'pending' },
			{ status: 'failed' },
			{ amount: -1 },
			{ amount: 1.5 },
			{ currency: null },
			{ created: Number.MAX_SAFE_INTEGER },
		]) {
			expect(
				purchaseRefundFacts({
					purchaseId: 'purchase-1',
					refund: { ...refund, ...override },
				}),
			).toBeUndefined()
		}
	})
})
