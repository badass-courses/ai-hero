import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	issuedRow,
	offerPayload,
} from '@/lib/subscriber-marketing/evergreen-offer-status.fixtures'

const mocks = vi.hoisted(() => ({
	createFunction: vi.fn(
		(config: unknown, trigger: unknown, handler: unknown) => ({
			config,
			trigger,
			handler,
		}),
	),
	findPurchase: vi.fn(),
	findUser: vi.fn(),
	selectCoupon: vi.fn(),
	write: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: mocks.createFunction },
}))
vi.mock('@/db', () => ({
	db: {
		query: {
			purchases: { findFirst: mocks.findPurchase },
			users: { findFirst: mocks.findUser },
		},
		select: () => ({
			from: () => ({ where: () => ({ limit: mocks.selectCoupon }) }),
		}),
	},
}))
vi.mock('@/lib/subscriber-marketing/drizzle-capture-repository', () => ({
	DrizzleCaptureMarketingRepository: class {},
}))
vi.mock('@/lib/subscriber-marketing/lifecycle-contact-events', () => ({
	writePurchaseRecordedContactEvents: mocks.write,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))

import { capturePurchaseContactEvent } from './capture-purchase-contact-event'

type Registered = {
	handler: (input: Record<string, unknown>) => Promise<unknown>
}
const registered = capturePurchaseContactEvent as unknown as Registered

const step = { run: vi.fn(async (_id: string, work: () => unknown) => work()) }

function purchaseRow(couponId: string | null) {
	return {
		id: 'purch_1',
		userId: 'user-1',
		productId: 'product-ma254',
		status: 'Valid',
		totalAmount: 199,
		createdAt: new Date('2026-10-02T12:00:00.000Z'),
		couponId,
		redeemedBulkCouponId: null,
		bulkCouponId: null,
	}
}

async function run() {
	await registered.handler({
		event: { name: 'commerce/new-purchase-created', data: { purchaseId: 'purch_1' } },
		step,
	})
	return mocks.write.mock.calls[0]?.[0].rows[0]
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.findUser.mockResolvedValue({ email: 'buyer@example.com', name: null })
	mocks.write.mockResolvedValue({
		counts: { written: 1, skippedByReason: {} },
		decisions: [],
	})
})

describe('capture purchase contact event (row 194)', () => {
	it('names the contact the redeemed evergreen coupon was issued to', async () => {
		const { row, couponId } = await issuedRow(offerPayload())
		mocks.findPurchase.mockResolvedValue(purchaseRow(couponId))
		mocks.selectCoupon.mockResolvedValue([row])

		expect(await run()).toMatchObject({
			purchaseId: 'purch_1',
			userId: 'user-1',
			evergreenOffer: { couponId, contactId: 'contact-status-fixture' },
		})
		expect(step.run).toHaveBeenCalledWith(
			'load evergreen coupon',
			expect.any(Function),
		)
	})

	it('falls back to the buyer, and says so, when the coupon cannot be read', async () => {
		const couponId = `eoj-coupon:${'d'.repeat(64)}`
		mocks.findPurchase.mockResolvedValue(purchaseRow(couponId))
		mocks.selectCoupon.mockResolvedValue([])

		const source = await run()
		expect(source).not.toHaveProperty('evergreenOffer')
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'contact_event.purchase_recorded.evergreen_coupon_refused',
			{ purchaseId: 'purch_1', couponId, reason: 'coupon-missing' },
		)
	})

	it('reads no coupon for any other purchase', async () => {
		mocks.findPurchase.mockResolvedValue(purchaseRow('ppp-coupon'))

		expect(await run()).not.toHaveProperty('evergreenOffer')
		expect(mocks.selectCoupon).not.toHaveBeenCalled()
	})
})
