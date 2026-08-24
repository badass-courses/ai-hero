import { describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'

import {
	parseCheckoutRecoveryArgs,
	runCheckoutRecovery,
	type CheckoutRecoveryRuntime,
	type CheckoutRecoveryState,
} from './checkout-recovery'

const session = {
	id: 'cs_test_recovery',
	object: 'checkout.session',
	amount_subtotal: 19_900,
	amount_total: 19_900,
	created: 1_777_777_777,
	currency: 'usd',
	custom_fields: [],
	customer: { id: 'cus_recovery' },
	customer_details: {
		address: {
			city: 'Portland',
			country: 'US',
			line1: null,
			line2: null,
			postal_code: '97201',
			state: 'OR',
		},
		email: 'buyer@example.com',
		name: 'Buyer',
	},
	livemode: false,
	metadata: {},
	mode: 'payment',
	payment_intent: {
		id: 'pi_recovery',
		latest_charge: { id: 'ch_recovery' },
	},
	payment_method_collection: 'always',
	payment_status: 'paid',
	phone_number_collection: { enabled: false },
	status: 'complete',
	subscription: null,
	success_url: 'https://example.com/thanks',
	total_details: {
		amount_discount: 0,
		amount_shipping: 0,
		amount_tax: 0,
	},
} as unknown as Stripe.Checkout.Session

const intermediateState: CheckoutRecoveryState = {
	chargeIds: ['mc_recovery'],
	merchantSessionIds: ['ms_recovery'],
	purchaseIds: [],
}

function runtime(
	state: CheckoutRecoveryState = intermediateState,
): CheckoutRecoveryRuntime & {
	sendReplay: ReturnType<typeof vi.fn>
} {
	return {
		getCheckoutSession: vi.fn().mockResolvedValue(session),
		inspect: vi.fn().mockResolvedValue(state),
		sendReplay: vi.fn().mockResolvedValue({ ids: ['evt_inngest_recovery'] }),
		close: vi.fn().mockResolvedValue(undefined),
	}
}

describe('checkout recovery command', () => {
	it('accepts one exact session id and defaults to dry-run', () => {
		expect(
			parseCheckoutRecoveryArgs([
				'--checkout-session-id',
				'cs_test_recovery',
			]),
		).toEqual({
			checkoutSessionId: 'cs_test_recovery',
			apply: false,
			receiptPath: undefined,
		})
		expect(() =>
			parseCheckoutRecoveryArgs([
				'--checkout-session-id',
				'cs_test_recovery',
				'cs_test_second',
			]),
		).toThrow('Unknown argument')
	})

	it('reports the paid intermediate state without sending in dry-run', async () => {
		const testRuntime = runtime()
		const receipt = await runCheckoutRecovery(
			{ checkoutSessionId: session.id, apply: false },
			testRuntime,
		)

		expect(receipt).toMatchObject({
			status: 'would_replay',
			success: true,
			chargeId: 'ch_recovery',
			state: intermediateState,
		})
		expect(receipt.recoveryEventId).toMatch(/^aih-checkout-recovery-/)
		expect(testRuntime.sendReplay).not.toHaveBeenCalled()
	})

	it('sends one deterministic checkout replay in apply mode', async () => {
		const testRuntime = runtime()
		const first = await runCheckoutRecovery(
			{ checkoutSessionId: session.id, apply: true },
			testRuntime,
		)

		expect(first).toMatchObject({
			status: 'replay_requested',
			success: true,
			inngestEventIds: ['evt_inngest_recovery'],
		})
		expect(testRuntime.sendReplay).toHaveBeenCalledTimes(1)
		const event = testRuntime.sendReplay.mock.calls[0]?.[0]
		expect(event).toMatchObject({
			id: first.recoveryEventId,
			name: 'stripe/checkout-session-completed',
			data: {
				stripeEvent: {
					type: 'checkout.session.completed',
					data: {
						object: {
							id: session.id,
							payment_intent: 'pi_recovery',
						},
					},
				},
			},
		})
	})

	it('does not replay fulfillment when a purchase already exists', async () => {
		const testRuntime = runtime({
			...intermediateState,
			purchaseIds: ['purch_recovered'],
		})
		const receipt = await runCheckoutRecovery(
			{ checkoutSessionId: session.id, apply: true },
			testRuntime,
		)

		expect(receipt.status).toBe('already_recovered')
		expect(testRuntime.sendReplay).not.toHaveBeenCalled()
	})

	it('refuses an unpaid session', async () => {
		const testRuntime = runtime()
		testRuntime.getCheckoutSession = vi.fn().mockResolvedValue({
			...session,
			payment_status: 'unpaid',
		})
		const receipt = await runCheckoutRecovery(
			{ checkoutSessionId: session.id, apply: true },
			testRuntime,
		)

		expect(receipt).toMatchObject({ status: 'refused', success: false })
		expect(testRuntime.sendReplay).not.toHaveBeenCalled()
	})
})

describe('checkout recovery argument parsing', () => {
	it('parses apply mode and an explicit receipt path', () => {
		expect(
			parseCheckoutRecoveryArgs([
				'--checkout-session-id',
				'cs_live_recovery1',
				'--apply',
				'--receipt',
				'tmp/receipt.json',
			]),
		).toEqual({
			checkoutSessionId: 'cs_live_recovery1',
			apply: true,
			receiptPath: 'tmp/receipt.json',
		})
	})

	it('rejects a flag whose value is missing or is another flag', () => {
		expect(() => parseCheckoutRecoveryArgs(['--checkout-session-id'])).toThrow(
			'--checkout-session-id requires a value',
		)
		expect(() =>
			parseCheckoutRecoveryArgs([
				'--checkout-session-id',
				'cs_test_recovery',
				'--receipt',
				'--apply',
			]),
		).toThrow('--receipt requires a value')
	})

	it('rejects a missing or malformed session id', () => {
		const message = '--checkout-session-id must be one exact Stripe session id'
		expect(() => parseCheckoutRecoveryArgs([])).toThrow(message)
		expect(() => parseCheckoutRecoveryArgs(['--apply'])).toThrow(message)
		expect(() =>
			parseCheckoutRecoveryArgs(['--checkout-session-id', 'pi_not_a_session']),
		).toThrow(message)
		expect(() =>
			parseCheckoutRecoveryArgs(['--checkout-session-id', 'cs_test_bad id']),
		).toThrow(message)
	})

	it('rejects the bare separator the pnpm 9 runbook used', () => {
		expect(() =>
			parseCheckoutRecoveryArgs(['--', '--checkout-session-id', 'cs_test_x']),
		).toThrow('Unknown argument: --')
	})
})
