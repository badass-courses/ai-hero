import { describe, expect, it } from 'vitest'

import {
	CHECKOUT_RECONCILE_KILL_SWITCH_ENV,
	checkoutAutoFulfillEnabled,
	checkoutChargeState,
	checkoutReconcileKey,
	classifyCheckoutSession,
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
		expect(classify({ created: minutesAgo(4) })).toEqual({
			kind: 'skip',
			reason: 'too_young',
		})
		expect(classify({ created: minutesAgo(49 * 60) })).toEqual({
			kind: 'skip',
			reason: 'outside_window',
		})
	})

	it('keeps auto-fulfill on unless the kill switch is set', () => {
		expect(checkoutAutoFulfillEnabled({})).toBe(true)
		expect(
			checkoutAutoFulfillEnabled({ [CHECKOUT_RECONCILE_KILL_SWITCH_ENV]: 'false' }),
		).toBe(true)
		expect(
			checkoutAutoFulfillEnabled({ [CHECKOUT_RECONCILE_KILL_SWITCH_ENV]: 'true' }),
		).toBe(false)
		expect(
			checkoutAutoFulfillEnabled({ [CHECKOUT_RECONCILE_KILL_SWITCH_ENV]: ' 1 ' }),
		).toBe(false)
	})

	it('uses a reconcile key distinct from the bare session id', () => {
		expect(checkoutReconcileKey('cs_test_paid')).toBe(
			'checkout-reconcile:cs_test_paid',
		)
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
