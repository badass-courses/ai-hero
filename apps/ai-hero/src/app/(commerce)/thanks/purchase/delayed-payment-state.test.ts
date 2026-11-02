import type Stripe from 'stripe'
import { describe, expect, it } from 'vitest'

import {
	delayedPaymentCopy,
	delayedPaymentState,
	type DelayedPaymentState,
} from './delayed-payment-state'

const INSTRUCTIONS = 'https://payments.stripe.test/bank_transfer/instructions'

function intent(
	status: Stripe.PaymentIntent.Status,
	nextAction: Partial<Stripe.PaymentIntent.NextAction> | null = null,
) {
	return { id: 'pi_test', status, next_action: nextAction } as Stripe.PaymentIntent
}

const bankTransferAction = {
	type: 'display_bank_transfer_instructions',
	display_bank_transfer_instructions: {
		hosted_instructions_url: INSTRUCTIONS,
	},
} as Partial<Stripe.PaymentIntent.NextAction>

describe('delayedPaymentState', () => {
	it('is not delayed once the session is paid', () => {
		expect(
			delayedPaymentState({
				status: 'complete',
				payment_status: 'paid',
				payment_intent: intent('succeeded'),
			}),
		).toEqual({ kind: 'not_delayed' })
	})

	it('is not delayed while checkout is still open', () => {
		expect(
			delayedPaymentState({
				status: 'open',
				payment_status: 'unpaid',
				payment_intent: null,
			}),
		).toEqual({ kind: 'not_delayed' })
	})

	it('waits on a bank transfer and links its instructions', () => {
		expect(
			delayedPaymentState({
				status: 'complete',
				payment_status: 'unpaid',
				payment_intent: intent('requires_action', bankTransferAction),
			}),
		).toEqual({
			kind: 'awaiting_payment',
			method: 'bank_transfer',
			instructionsUrl: INSTRUCTIONS,
		})
	})

	it('waits on any other delayed method without instructions', () => {
		expect(
			delayedPaymentState({
				status: 'complete',
				payment_status: 'unpaid',
				payment_intent: intent('processing'),
			}),
		).toEqual({ kind: 'awaiting_payment', method: 'other', instructionsUrl: null })
	})

	it('reports a failed delayed payment', () => {
		for (const status of ['canceled', 'requires_payment_method'] as const)
			expect(
				delayedPaymentState({
					status: 'complete',
					payment_status: 'unpaid',
					payment_intent: intent(status),
				}),
			).toEqual({ kind: 'payment_failed' })
	})
})

describe('delayedPaymentCopy', () => {
	const states: Exclude<DelayedPaymentState, { kind: 'not_delayed' }>[] = [
		{ kind: 'awaiting_payment', method: 'bank_transfer', instructionsUrl: INSTRUCTIONS },
		{ kind: 'awaiting_payment', method: 'bank_transfer', instructionsUrl: null },
		{ kind: 'awaiting_payment', method: 'other', instructionsUrl: null },
		{ kind: 'payment_failed' },
	]

	it('tells a bank-transfer buyer that access waits on the transfer', () => {
		const copy = delayedPaymentCopy(states[0]!)
		expect(copy.title).toBe("We're waiting for your bank transfer")
		expect(copy.body.join(' ')).toContain('usually within 1 to 3 business days')
		expect(copy.body.join(' ')).toContain("we'll email you and give you access")
		expect(copy.instructionsLabel).toBe('View transfer details')
		expect(delayedPaymentCopy(states[1]!).instructionsLabel).toBeNull()
	})

	it('never promises access for a failed payment', () => {
		const copy = delayedPaymentCopy({ kind: 'payment_failed' })
		expect(copy.title).toBe("Your payment didn't go through")
		expect(copy.body.join(' ')).not.toContain("we'll email you and give you access")
	})

	it('uses no em or en dashes', () => {
		for (const state of states) {
			const copy = delayedPaymentCopy(state)
			const text = [copy.eyebrow, copy.title, ...copy.body, copy.instructionsLabel ?? ''].join(' ')
			expect(text).not.toMatch(/[\u2013\u2014]/)
		}
	})
})
