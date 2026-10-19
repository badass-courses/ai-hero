import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
	purchase: vi.fn(),
	session: vi.fn(),
	charge: vi.fn(),
	payment: vi.fn(),
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: { getPurchase: mocks.purchase },
	db: {
		query: {
			merchantSession: { findFirst: mocks.session },
			merchantCharge: { findFirst: mocks.charge },
		},
	},
}))
vi.mock('@/db/schema', () => ({
	merchantCharge: { id: 'charge' },
	merchantSession: { id: 'session' },
}))
vi.mock('@/coursebuilder/stripe-provider', () => ({
	stripeProvider: {
		options: {
			paymentsAdapter: { stripe: { charges: { retrieve: mocks.payment } } },
		},
	},
}))
import {
	purchaseBuyPathContext,
	readPurchaseBuyPathContext,
} from './read-context'

describe('purchase telemetry read classification', () => {
	beforeEach(() => {
		vi.resetAllMocks()
		mocks.purchase.mockResolvedValue({
			id: 'purchase_fixture',
			merchantSessionId: 'session_fixture',
			merchantChargeId: 'charge_fixture',
			productId: 'product_fixture',
			userId: null,
		})
		mocks.session.mockResolvedValue({ identifier: 'cs_test_fixture' })
		mocks.charge.mockResolvedValue({ identifier: 'ch_fixture' })
		mocks.payment.mockResolvedValue({ created: 123 })
	})
	it('keeps checkout context and payment timestamp', async () => {
		expect(await readPurchaseBuyPathContext('purchase_fixture')).toEqual({
			reason: 'checkout',
			context: {
				buyPathId: 'cs_test_fixture',
				purchaseId: 'purchase_fixture',
				productId: 'product_fixture',
				userId: null,
				paymentAt: 123000,
				chargeId: 'ch_fixture',
			},
		})
	})
	it.each([null, { id: 'purchase_fixture' }])(
		'classifies absent purchase/session',
		async (purchase) => {
			mocks.purchase.mockResolvedValue(purchase)
			expect(await readPurchaseBuyPathContext('purchase_fixture')).toEqual({
				reason: 'no-merchant-session',
				context: null,
			})
			expect(mocks.session).not.toHaveBeenCalled()
		},
	)
	it.each([null, { identifier: 'pi_fixture' }, { identifier: 'in_fixture' }])(
		'classifies non-checkout sessions',
		async (session) => {
			mocks.session.mockResolvedValue(session)
			expect(await readPurchaseBuyPathContext('purchase_fixture')).toEqual({
				reason: 'not-checkout-session',
				context: null,
			})
			expect(mocks.payment).not.toHaveBeenCalled()
		},
	)
	it('retains partial context when charge is missing', async () => {
		mocks.charge.mockResolvedValue(null)
		expect(await readPurchaseBuyPathContext('purchase_fixture')).toEqual({
			reason: 'missing-charge',
			context: expect.objectContaining({
				buyPathId: 'cs_test_fixture',
				chargeId: null,
				paymentAt: null,
			}),
		})
		expect(await purchaseBuyPathContext('purchase_fixture')).not.toBeNull()
	})
	it.each(['purchase', 'session', 'charge', 'payment'] as const)(
		'classifies thrown %s reads and preserves the legacy exception contract',
		async (stage) => {
			const error = new TypeError('synthetic read failure')
			mocks[stage].mockRejectedValue(error)
			expect(await readPurchaseBuyPathContext('purchase_fixture')).toEqual({
				reason: 'threw',
				context: null,
				error,
			})
			await expect(purchaseBuyPathContext('purchase_fixture')).rejects.toBe(
				error,
			)
		},
	)
	it('preserves null for legacy callers without checkout context', async () => {
		mocks.purchase.mockResolvedValue(null)
		expect(await purchaseBuyPathContext('purchase_fixture')).toBeNull()
	})
})
