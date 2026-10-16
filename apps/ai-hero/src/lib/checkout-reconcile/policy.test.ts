import { describe, expect, it } from 'vitest'

import {
	CHECKOUT_RECONCILE_AUTO_FULFILL_ENV,
	checkoutAutoFulfillEnabled,
	checkoutChargeState,
	checkoutReconcileKey,
	classifyCheckoutSession,
	safeCheckoutErrorLabel,
	summarizeCheckoutSession,
	type CheckoutSessionSummary,
} from './policy'

const now = new Date('2026-10-09T22:00:00Z')
const minutesAgo = (minutes: number) =>
	Math.floor(now.getTime() / 1000) - minutes * 60

const paid: CheckoutSessionSummary = {
	id: 'cs_test_paid',
	created: minutesAgo(12),
	mode: 'payment',
	status: 'complete',
	paymentStatus: 'paid',
	amountTotal: 29_900,
	siteName: 'ai-hero',
	chargeId: 'ch_paid',
	paidAt: minutesAgo(12),
	charge: {
		chargeId: 'ch_paid',
		expanded: true,
		refunded: false,
		disputed: false,
		amountRefunded: 0,
	},
}

const classify = (session: Partial<CheckoutSessionSummary>) =>
	classifyCheckoutSession({ ...paid, ...session }, { now, appName: 'ai-hero' })

describe('checkout reconcile policy', () => {
	it('treats a paid, completed, labelled session older than 5 minutes as a candidate', () => {
		expect(classify({})).toEqual({ kind: 'candidate', ageMs: 12 * 60_000 })
	})

	it('ignores unpaid, expired, subscription, zero-total and other-site sessions', () => {
		expect(classify({ paymentStatus: 'unpaid' })).toEqual({
			kind: 'skip',
			reason: 'not_paid',
		})
		expect(classify({ status: 'expired', paymentStatus: 'unpaid' })).toEqual({
			kind: 'skip',
			reason: 'not_complete',
		})
		expect(classify({ mode: 'subscription' })).toEqual({
			kind: 'skip',
			reason: 'not_payment_mode',
		})
		// The webhook quarantines zero-total payment sessions on purpose.
		expect(classify({ amountTotal: 0 })).toEqual({
			kind: 'skip',
			reason: 'zero_total',
		})
		expect(classify({ siteName: 'other-site' })).toEqual({
			kind: 'skip',
			reason: 'other_site',
		})
		expect(classify({ siteName: null })).toEqual({
			kind: 'skip',
			reason: 'other_site',
		})
	})

	it('leaves young sessions to the normal path and ignores ones past 48 hours', () => {
		expect(
			classify({ created: minutesAgo(4), paidAt: minutesAgo(4) }),
		).toEqual({
			kind: 'skip',
			reason: 'too_young',
		})
		expect(classify({ created: minutesAgo(49 * 60) })).toEqual({
			kind: 'skip',
			reason: 'outside_window',
		})
	})

	it('measures age from payment, not from when checkout opened', () => {
		// Opened 40 minutes ago, paid 2 minutes ago: still the normal path's.
		expect(
			classify({ created: minutesAgo(40), paidAt: minutesAgo(2) }),
		).toEqual({ kind: 'skip', reason: 'too_young' })
		// Paid 6 minutes ago: a candidate, 6 minutes old, not 40.
		expect(
			classify({ created: minutesAgo(40), paidAt: minutesAgo(6) }),
		).toEqual({ kind: 'candidate', ageMs: 6 * 60_000 })
		// No payment time: the session's creation is the only clock.
		expect(classify({ created: minutesAgo(9), paidAt: null })).toEqual({
			kind: 'candidate',
			ageMs: 9 * 60_000,
		})
	})

	it('takes payment time from the charge, then the payment intent', () => {
		const base = {
			id: 'cs_1',
			created: 100,
			mode: 'payment',
			status: 'complete',
			payment_status: 'paid',
			amount_total: 100,
			metadata: { siteName: 'ai-hero' },
		}
		expect(
			summarizeCheckoutSession({
				...base,
				payment_intent: {
					created: 200,
					latest_charge: {
						id: 'ch_1',
						created: 300,
						refunded: false,
						amount_refunded: 0,
						disputed: false,
					},
				},
			} as never),
		).toMatchObject({ chargeId: 'ch_1', paidAt: 300, charge: { expanded: true } })
		expect(
			summarizeCheckoutSession({
				...base,
				payment_intent: { created: 200, latest_charge: 'ch_2' },
			} as never),
		).toMatchObject({ chargeId: 'ch_2', paidAt: 200, charge: { expanded: false } })
		expect(
			summarizeCheckoutSession({ ...base, payment_intent: 'pi_3' } as never),
		).toMatchObject({ chargeId: null, paidAt: null })
	})

	it('keeps auto-fulfill off unless it is opted in', () => {
		expect(checkoutAutoFulfillEnabled({})).toBe(false)
		expect(
			checkoutAutoFulfillEnabled({ [CHECKOUT_RECONCILE_AUTO_FULFILL_ENV]: 'false' }),
		).toBe(false)
		expect(
			checkoutAutoFulfillEnabled({ [CHECKOUT_RECONCILE_AUTO_FULFILL_ENV]: 'yes' }),
		).toBe(false)
		expect(
			checkoutAutoFulfillEnabled({ [CHECKOUT_RECONCILE_AUTO_FULFILL_ENV]: 'true' }),
		).toBe(true)
		expect(
			checkoutAutoFulfillEnabled({ [CHECKOUT_RECONCILE_AUTO_FULFILL_ENV]: ' 1 ' }),
		).toBe(true)
	})

	it('uses a reconcile key distinct from the bare session id, bucketed by UTC hour', () => {
		expect(
			checkoutReconcileKey('cs_test_paid', new Date('2026-10-09T22:47:31Z')),
		).toBe('checkout-reconcile:cs_test_paid:2026100922')
		expect(
			checkoutReconcileKey('cs_test_paid', new Date('2026-10-09T23:00:00Z')),
		).toBe('checkout-reconcile:cs_test_paid:2026100923')
	})

	it('labels errors for Slack and Axiom without the buyer email', () => {
		expect(
			safeCheckoutErrorLabel(new Error('no user for buyer@example.com yet')),
		).toEqual({
			errorName: 'Error',
			errorSummary: 'no user for [email] yet',
		})
		// The adapter glues the email to its code; the whole token goes.
		expect(
			safeCheckoutErrorLabel(
				new Error('unable-to-create-user-buyer.name+tag@example.co.uk'),
			).errorSummary,
		).not.toContain('@')
		expect(
			safeCheckoutErrorLabel(new Error('x'.repeat(200))).errorSummary,
		).toHaveLength(81)
	})

	it('reads refund and dispute state only from an expanded charge', () => {
		expect(
			checkoutChargeState({
				payment_intent: {
					latest_charge: {
						id: 'ch_1',
						refunded: false,
						amount_refunded: 500,
						disputed: false,
					},
				},
			} as never),
		).toEqual({
			chargeId: 'ch_1',
			expanded: true,
			refunded: true,
			disputed: false,
			amountRefunded: 500,
		})
		expect(
			checkoutChargeState({ payment_intent: { latest_charge: 'ch_2' } } as never),
		).toMatchObject({ chargeId: 'ch_2', expanded: false })
		expect(checkoutChargeState({ payment_intent: 'pi_3' } as never)).toMatchObject({
			chargeId: null,
			expanded: false,
		})
	})
})
