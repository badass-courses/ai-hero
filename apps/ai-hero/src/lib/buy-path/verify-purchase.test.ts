import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
	getPurchase: vi.fn(),
	access: vi.fn(),
	charge: vi.fn(),
	payment: vi.fn(),
	emit: vi.fn(),
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: { getPurchase: mocks.getPurchase },
	db: {
		select: () => ({ from: () => ({ where: mocks.access }) }),
		query: { merchantCharge: { findFirst: mocks.charge } },
	},
}))
vi.mock('@/db/schema', () => ({
	entitlements: {
		id: 'id',
		sourceId: 'sourceId',
		userId: 'userId',
		deletedAt: 'deletedAt',
		expiresAt: 'expiresAt',
	},
	merchantCharge: { id: 'id' },
}))
vi.mock('drizzle-orm', () => ({
	and: (...values: unknown[]) => values,
	eq: (...values: unknown[]) => values,
	isNull: (value: unknown) => value,
	gt: (...values: unknown[]) => values,
	or: (...values: unknown[]) => values,
	sql: (strings: TemplateStringsArray) => strings.join(''),
}))
vi.mock('@/coursebuilder/stripe-provider', () => ({
	stripeProvider: {
		options: {
			paymentsAdapter: { stripe: { charges: { retrieve: mocks.payment } } },
		},
	},
}))
vi.mock('./server', () => ({ emitBuyPath: mocks.emit }))
import { verifyPurchase } from './verify-purchase'
const context = {
	buyPathId: 'cs_test_fixture',
	purchaseId: 'purchase_fixture',
	productId: 'product_fixture',
	userId: 'user_fixture',
}
const purchase = {
	id: 'purchase_fixture',
	userId: 'user_fixture',
	productId: 'product_fixture',
	merchantChargeId: 'merchant_charge_fixture',
	totalAmount: '123.45',
	status: 'Valid',
	redeemedBulkCouponId: null,
}
beforeEach(() => {
	vi.clearAllMocks()
	mocks.getPurchase.mockResolvedValue(purchase)
	mocks.access.mockResolvedValue([{ id: 'entitlement_fixture' }])
	mocks.charge.mockResolvedValue({ identifier: 'ch_test_fixture' })
	mocks.payment.mockResolvedValue({ amount: 12345, created: 1767225600 })
	mocks.emit.mockResolvedValue(undefined)
})
describe('fresh purchase readback', () => {
	it('reads purchase again and does not claim the pending decision hook passed', async () => {
		const result = await verifyPurchase(context, 1)
		expect(mocks.getPurchase).toHaveBeenCalledWith('purchase_fixture')
		expect(result).toEqual({ failures: [], decisionChecked: false })
		expect(mocks.emit).toHaveBeenCalledWith(
			expect.objectContaining({ chargeId: 'ch_test_fixture' }),
			'invariant_checked',
			{ outcome: 'skipped', field: 'decision' },
		)
	})
	it.each(['purchase', 'status', 'entitlements', 'charge', 'amount'] as const)(
		'emits %s mismatch from actual readback',
		async (field) => {
			if (field === 'purchase') mocks.getPurchase.mockResolvedValue(null)
			if (field === 'status')
				mocks.getPurchase.mockResolvedValue({ ...purchase, status: 'Refunded' })
			if (field === 'entitlements') mocks.access.mockResolvedValue([])
			if (field === 'charge') mocks.charge.mockResolvedValue(null)
			if (field === 'amount')
				mocks.payment.mockResolvedValue({ amount: 12344, created: 1767225600 })
			await verifyPurchase(context, 1)
			expect(mocks.emit).toHaveBeenCalledWith(
				expect.anything(),
				'invariant_failed',
				{ outcome: 'failed', field },
			)
		},
	)
	it('treats a provider read failure as failed charge and amount checks', async () => {
		mocks.payment.mockRejectedValue(Error('transport failed'))
		const result = await verifyPurchase(context, 1)
		expect(result.failures).toEqual(['charge', 'amount'])
	})
})
