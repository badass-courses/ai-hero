import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readDelayedPaymentState } from './read-delayed-payment-state'

const mocks = vi.hoisted(() => ({ retrieve: vi.fn(), warn: vi.fn() }))
vi.mock('@/coursebuilder/stripe-provider', () => ({
	stripeProvider: {
		options: {
			paymentsAdapter: {
				stripe: { checkout: { sessions: { retrieve: mocks.retrieve } } },
			},
		},
	},
}))
vi.mock('@/server/logger', () => ({ log: { warn: mocks.warn } }))

const SESSION_ID = 'cs_test_a1B2c3D4e5F6g7H8i9J0kLmN'

describe('readDelayedPaymentState', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it.each([
		'',
		'junk',
		'cs_test_short',
		'cs_prod_a1B2c3D4e5F6g7H8i9J0kLmN',
		'pi_test_a1B2c3D4e5F6g7H8i9J0kLmN',
		`${SESSION_ID}/../../v1/customers`,
		`${SESSION_ID}?expand=customer`,
	])('skips the Stripe read for %j', async (id) => {
		expect(await readDelayedPaymentState(id)).toEqual({ kind: 'not_delayed' })
		expect(mocks.retrieve).not.toHaveBeenCalled()
	})

	it.each([SESSION_ID, 'cs_live_a1B2c3D4e5F6g7H8i9J0kLmN'])(
		'reads Stripe for %j',
		async (id) => {
			mocks.retrieve.mockResolvedValue({
				status: 'complete',
				payment_status: 'unpaid',
				payment_intent: { status: 'requires_action', next_action: null },
			})
			expect(await readDelayedPaymentState(id)).toMatchObject({
				kind: 'awaiting_payment',
			})
			expect(mocks.retrieve).toHaveBeenCalledWith(
				id,
				{ expand: ['payment_intent'] },
				{ timeout: 3000, maxNetworkRetries: 0 },
			)
		},
	)

	it('falls back to the wait screen when Stripe fails', async () => {
		mocks.retrieve.mockRejectedValue(new Error('timeout'))
		expect(await readDelayedPaymentState(SESSION_ID)).toEqual({
			kind: 'not_delayed',
		})
		expect(mocks.warn).toHaveBeenCalledWith(
			'checkout.thanks.payment_state_unavailable',
			{ checkoutSessionId: SESSION_ID },
		)
	})
})
