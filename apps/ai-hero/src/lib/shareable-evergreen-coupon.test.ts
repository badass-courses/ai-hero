import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCouponForCode } from '@coursebuilder/commerce/props-for-commerce'
import { readCommerceUrlParams } from '@/app/(content)/workshops/_components/commerce-url-params'
import { evergreenJourneyIdForContact } from './subscriber-marketing/drovr-evergreen-coupon'
import { couponIntentKey } from './subscriber-marketing/evergreen-offer-journey/primitives'
import {
	semanticCouponId,
	type CommerceCouponRow,
} from './subscriber-marketing/evergreen-offer-journey/coupon-authority'
import { authorizeExclusiveCouponSelection } from './exclusive-coupon-authorization'
import { protectCourseBuilderRequest } from '@/coursebuilder/coursebuilder-request-authorization'

const issueAt = '2026-09-24T16:00:00.000Z'
const expiresAt = '2026-09-25T06:59:59.000Z'
const journeyId = evergreenJourneyIdForContact('contact-smoke-1')
const idempotencyKey = couponIntentKey(journeyId)
const couponId = semanticCouponId(idempotencyKey)
const merchant = {
	id: 'merchant-evergreen',
	type: 'special',
	status: 1,
	amountDiscount: 10_000,
}
const issue = {
	type: 'IssueCoupon',
	idempotencyKey,
	journeyId,
	contactId: 'contact-smoke-1',
	issueAt,
	expiresAt,
	terms: {
		productId: 'product-ma254',
		currency: 'USD',
		amountOffCents: 10_000,
		maxUses: 1,
		exclusive: true,
	},
	deadlineTimeZone: {
		type: 'BrowserEntryHeader',
		headerName: 'x-vercel-ip-timezone',
		timeZone: 'America/Los_Angeles',
		capturedAt: issueAt,
	},
}
function coupon(overrides: Partial<CommerceCouponRow> = {}): CommerceCouponRow {
	return {
		id: couponId,
		code: null,
		organizationId: null,
		createdAt: new Date(issueAt),
		expires: new Date(expiresAt),
		fields: {
			exclusive: true,
			evergreenOffer: {
				format: 1,
				issue,
				binding: { type: 'AwaitingVerifiedUser' },
			},
		},
		maxUses: 1,
		default: false,
		merchantCouponId: merchant.id,
		status: 1,
		usedCount: 0,
		percentageDiscount: null,
		amountDiscount: 10_000,
		restrictedToProductId: 'product-ma254',
		...overrides,
	} as CommerceCouponRow
}
const adapter = (row: CommerceCouponRow) => ({
	getCoupon: async (id: string) => (id === couponId ? row : null),
	getMerchantCoupon: async (id: string) =>
		id === merchant.id ? merchant : null,
	getEntitlementTypeByName: async () => null,
	getEntitlementsForUser: async () => [],
})

async function checkoutSelectorsFor(row: CommerceCouponRow) {
	const url = new URL('https://aihero.dev/api/coursebuilder/checkout/stripe')
	url.searchParams.set('productId', 'product-ma254')
	url.searchParams.set('quantity', '1')
	url.searchParams.set('couponId', merchant.id)
	url.searchParams.set('usedCouponId', couponId)
	const guarded = await protectCourseBuilderRequest(
		new NextRequest(url, { method: 'POST' }),
		{
			adapter: adapter(row),
			verifiedUserId: undefined,
		},
	)
	return guarded.nextUrl.searchParams
}

describe('shared evergreen link through existing coupon pricing', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-09-24T18:00:00.000Z'))
	})
	afterEach(() => {
		vi.useRealTimers()
	})
	it.each(['claim', 'coupon'])(
		'maps signed-out ?%s= to a redeemable $199 site coupon',
		async (key) => {
			const query = new URLSearchParams([[key, couponId]])
			const { params, hasCommerceParams } = readCommerceUrlParams(query)
			expect(hasCommerceParams).toBe(true)
			expect(params.coupon).toBe(couponId)
			const row = coupon()
			const found = await getCouponForCode(
				params.coupon!,
				['product-ma254'],
				adapter(row) as never,
			)
			expect(found).toMatchObject({
				id: couponId,
				isValid: true,
				merchantCouponId: merchant.id,
			})
			const allowed = await authorizeExclusiveCouponSelection({
				adapter: adapter(row),
				verifiedUserId: undefined,
				productId: 'product-ma254',
				quantity: 1,
				requestedSiteCouponId: found?.id,
				requestedMerchantCouponId: merchant.id,
				now: new Date('2026-09-24T18:00:00.000Z'),
			})
			expect(allowed.authorized).toBe(true)
			expect(allowed.entitlementCouponId).toBeUndefined()
			const checkout = await checkoutSelectorsFor(row)
			expect(checkout.get('couponId')).toBe(merchant.id)
			expect(checkout.get('usedCouponId')).toBe(couponId)
		},
	)

	it.each([
		['expired', { expires: new Date('2026-09-24T17:00:00.000Z') }],
		['used up', { usedCount: 1 }],
		['wrong product', { restrictedToProductId: 'different-product' }],
		['forged provenance', { fields: { exclusive: true } }],
	] as const)(
		'does not apply an %s evergreen coupon',
		async (_label, overrides) => {
			const row = coupon(overrides)
			const found = await getCouponForCode(
				couponId,
				['product-ma254'],
				adapter(row) as never,
			)
			const allowed = await authorizeExclusiveCouponSelection({
				adapter: adapter(row),
				productId: 'product-ma254',
				quantity: 1,
				requestedSiteCouponId: couponId,
				requestedMerchantCouponId: merchant.id,
				now: new Date('2026-09-24T18:00:00.000Z'),
			})
			expect(allowed.authorized).toBe(false)
			const checkout = await checkoutSelectorsFor(row)
			expect(checkout.has('couponId')).toBe(false)
			expect(checkout.has('usedCouponId')).toBe(false)
			if (_label !== 'forged provenance') expect(found?.isValid).toBe(false)
		},
	)
	it('does not turn one-use evergreen discounts into bulk or forged merchant credits', async () => {
		const row = coupon()
		const bulk = await authorizeExclusiveCouponSelection({
			adapter: adapter(row),
			productId: 'product-ma254',
			quantity: 2,
			requestedSiteCouponId: couponId,
			requestedMerchantCouponId: merchant.id,
			now: new Date('2026-09-24T18:00:00.000Z'),
		})
		expect(bulk.authorized).toBe(false)

		const wrongAmount = await authorizeExclusiveCouponSelection({
			adapter: {
				...adapter(row),
				getMerchantCoupon: async () => ({ ...merchant, amountDiscount: 50_000 }),
			},
			productId: 'product-ma254',
			quantity: 1,
			requestedSiteCouponId: couponId,
			requestedMerchantCouponId: merchant.id,
			now: new Date('2026-09-24T18:00:00.000Z'),
		})
		expect(wrongAmount.authorized).toBe(false)
	})

	it('a bad id is neither a coupon nor a credential', async () => {
		expect(
			await getCouponForCode(
				'eoj-coupon:bad',
				['product-ma254'],
				adapter(coupon()) as never,
			),
		).toBeUndefined()
	})
})
