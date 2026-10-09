import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	lookupUser: vi.fn(),
	purchases: vi.fn(),
	charge: vi.fn(),
	refunds: vi.fn(),
	disputes: vi.fn(),
}))
vi.mock('../support/integration', () => ({
	integration: { lookupUser: mocks.lookupUser },
}))
vi.mock('@/db', () => ({
	db: { query: { purchases: { findMany: mocks.purchases } } },
}))
vi.mock('@/coursebuilder/stripe-provider', () => ({
	stripeProvider: {
		options: {
			paymentsAdapter: {
				stripe: {
					charges: { retrieve: mocks.charge },
					refunds: { list: mocks.refunds },
					disputes: { list: mocks.disputes },
				},
			},
		},
	},
}))
import { hooks } from './hooks'

beforeEach(() => {
	vi.clearAllMocks()
})
describe('front-desk read hooks', () => {
	it('maps a customer and handles a missing customer', async () => {
		mocks.lookupUser
			.mockResolvedValueOnce({ id: 'test-user', email: 'test@example.invalid' })
			.mockResolvedValueOnce(null)
		expect(await hooks.customerByEmail('test@example.invalid')).toEqual({
			id: 'test-user',
			email: 'test@example.invalid',
			name: null,
			emailAliases: [],
		})
		expect(await hooks.customerByEmail('missing@example.invalid')).toBeNull()
	})
	it('keeps merchant ids separate from Stripe identifiers and maps seats', async () => {
		mocks.purchases.mockResolvedValue([
			{
				id: 'test-purchase',
				productId: 'test-product',
				product: { name: 'Test Product' },
				totalAmount: '199.00',
				createdAt: new Date('2026-01-01'),
				status: 'Valid',
				bulkCoupon: { maxUses: 3 },
				merchantChargeId: 'merchant-test',
				merchantCharge: { identifier: 'ch_test' },
			},
			{
				id: 'test-free',
				productId: 'test-product',
				totalAmount: 0,
				createdAt: new Date('2026-01-01'),
				status: 'Valid',
				merchantChargeId: null,
			},
		])
		const purchases = await hooks.purchasesForUser('test-user')
		expect(purchases[0]).toMatchObject({
			merchantChargeId: 'merchant-test',
			stripeChargeId: 'ch_test',
			amount: 19900,
			seats: 3,
		})
		expect(purchases[1]).toMatchObject({
			merchantChargeId: null,
			stripeChargeId: null,
			amount: 0,
			seats: 1,
		})
	})
	it('never treats a non-charge merchant identifier as a Stripe charge id', async () => {
		mocks.purchases.mockResolvedValue([
			{
				id: 'test-purchase',
				productId: 'test-product',
				totalAmount: 0,
				createdAt: new Date('2026-01-01'),
				status: 'Valid',
				merchantChargeId: 'merchant-test',
				merchantCharge: { identifier: 'pi_test' },
			},
		])
		expect(
			(await hooks.purchasesForUser('test-user'))[0]?.stripeChargeId,
		).toBeNull()
	})
	it('reads all refund pages and dispute state with presentment details', async () => {
		mocks.charge.mockResolvedValue({
			id: 'ch_test',
			amount: 19900,
			currency: 'usd',
			amount_refunded: 2000,
			disputed: true,
			presentment_details: {
				presentment_amount: 18000,
				presentment_currency: 'eur',
			},
		})
		mocks.refunds
			.mockResolvedValueOnce({ data: [{ id: 're_one' }], has_more: true })
			.mockResolvedValueOnce({ data: [{ id: 're_two' }], has_more: false })
		mocks.disputes.mockResolvedValue({ data: [{ status: 'needs_response' }] })
		expect(await hooks.chargeState('ch_test')).toEqual({
			stripeChargeId: 'ch_test',
			amount: 19900,
			currency: 'usd',
			amountRefunded: 2000,
			refundCount: 2,
			disputed: true,
			disputeStatus: 'needs_response',
			presentmentAmount: 18000,
			presentmentCurrency: 'eur',
		})
		expect(mocks.refunds).toHaveBeenLastCalledWith({
			charge: 'ch_test',
			limit: 100,
			starting_after: 're_one',
		})
	})
	it('preserves missing presentment information instead of inventing it', async () => {
		mocks.charge.mockResolvedValue({
			id: 'ch_test',
			amount: 100,
			currency: 'usd',
			amount_refunded: 0,
			disputed: false,
		})
		mocks.refunds.mockResolvedValue({ data: [], has_more: false })
		expect(await hooks.chargeState('ch_test')).toMatchObject({
			refundCount: 0,
			disputeStatus: null,
			presentmentAmount: null,
			presentmentCurrency: null,
		})
		expect(mocks.disputes).not.toHaveBeenCalled()
	})
	it('returns null only for a missing Stripe resource, and propagates other failures to the facade', async () => {
		mocks.charge
			.mockRejectedValueOnce({ code: 'resource_missing' })
			.mockRejectedValueOnce(new Error('synthetic-error'))
		expect(await hooks.chargeState('ch_missing')).toBeNull()
		await expect(hooks.chargeState('ch_test')).rejects.toThrow(
			'synthetic-error',
		)
	})
})
