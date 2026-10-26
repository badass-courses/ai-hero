import type Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'

import {
	awaitsDelayedPayment,
	fulfillAsyncPaidCheckout,
	guardUnpaidCheckoutCompletion,
	type AsyncPaidCheckoutDeps,
} from './delayed-payment'
import {
	fulfillCheckoutSessionDirectly,
	type CheckoutFulfillStep,
} from './fulfill'

// Bank transfer: checkout opened 30 hours ago, the money landed just now.
const now = new Date('2026-10-26T18:00:00Z')
const APP = 'ai-hero'
const SESSION_ID = 'cs_test_bank_transfer'

function session(
	overrides: Partial<Stripe.Checkout.Session> = {},
): Stripe.Checkout.Session {
	return {
		id: SESSION_ID,
		object: 'checkout.session',
		amount_subtotal: 29_900,
		amount_total: 29_900,
		created: Math.floor(now.getTime() / 1000) - 30 * 3600,
		currency: 'usd',
		custom_fields: [],
		customer: { id: 'cus_bank_transfer', email: 'buyer@example.test' },
		customer_details: {
			address: null,
			email: 'buyer@example.test',
			name: 'Fixture Buyer',
		},
		livemode: false,
		metadata: {
			siteName: APP,
			productId: 'product_bank_transfer',
			userId: 'user_bank_transfer',
		},
		mode: 'payment',
		payment_intent: {
			id: 'pi_bank_transfer',
			created: Math.floor(now.getTime() / 1000) - 30 * 3600,
			latest_charge: {
				id: 'ch_bank_transfer',
				created: Math.floor(now.getTime() / 1000) - 60,
				refunded: false,
				amount_refunded: 0,
				disputed: false,
			},
		},
		payment_method_collection: 'always',
		payment_status: 'paid',
		phone_number_collection: { enabled: false },
		status: 'complete',
		subscription: null,
		success_url: 'https://example.test/thanks',
		total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
		...overrides,
	} as unknown as Stripe.Checkout.Session
}

function step(): CheckoutFulfillStep & { ran: string[] } {
	const ran: string[] = []
	return {
		ran,
		run: async (id, fn) => {
			ran.push(id)
			return fn()
		},
		sendEvent: async () => ({ ids: [] }),
	}
}

/** An in-memory store standing in for the purchase tables and the handler. */
function fixture(stripeSession = session()) {
	const purchases = new Map<string, string>()
	const handler = vi.fn(async ({ step, db }: any) => {
		const purchase = await step.run('create a merchant charge and purchase', () =>
			db.createMerchantChargeAndPurchase({
				productId: 'product_bank_transfer',
				userId: 'user_bank_transfer',
			}),
		)
		return { purchase }
	})
	const deps: AsyncPaidCheckoutDeps = {
		handler,
		step: step(),
		db: {
			createMerchantChargeAndPurchase: async () => {
				const id = `purchase_${purchases.size + 1}`
				purchases.set(SESSION_ID, id)
				return { id }
			},
		},
		paymentProvider: {},
		getCheckoutSession: async () => structuredClone(stripeSession),
		inspect: async () => ({
			chargeIds: purchases.size ? ['ch_bank_transfer'] : [],
			merchantSessionIds: [],
			purchaseIds: [...purchases.values()],
		}),
		findBuyerProductPurchases: async () => [],
		appName: APP,
		now: () => now,
		txnId: `aih-checkout-async-paid-${SESSION_ID}`,
	}
	return { deps, handler, purchases }
}

describe('awaitsDelayedPayment', () => {
	it('is true only for a completed, unpaid payment-mode session', () => {
		expect(
			awaitsDelayedPayment({ mode: 'payment', status: 'complete', payment_status: 'unpaid' }),
		).toBe(true)
		for (const other of [
			{ mode: 'payment', status: 'complete', payment_status: 'paid' },
			{ mode: 'payment', status: 'complete', payment_status: 'no_payment_required' },
			{ mode: 'payment', status: 'expired', payment_status: 'unpaid' },
			{ mode: 'subscription', status: 'complete', payment_status: 'unpaid' },
		])
			expect(awaitsDelayedPayment(other)).toBe(false)
	})
})

describe('guardUnpaidCheckoutCompletion', () => {
	const completedEvent = (paymentStatus: string) => ({
		name: 'stripe/checkout-session-completed',
		data: {
			txnId: 'txn_1',
			stripeEvent: {
				data: {
					object: {
						id: SESSION_ID,
						mode: 'payment',
						status: 'complete',
						payment_status: paymentStatus,
						amount_total: 29_900,
						metadata: { productId: 'product_bank_transfer' },
					},
				},
			},
		},
	})

	it('records an unpaid completion as awaiting payment without throwing or fulfilling', async () => {
		const handler = vi.fn(async (_input: unknown) => {
			throw new Error(
				`Stripe charge unavailable for checkout session ${SESSION_ID}; latest_charge is not ready yet`,
			)
		})
		const record = vi.fn(async () => undefined)
		const runStep = step()

		const result = await guardUnpaidCheckoutCompletion(handler, record)({
			event: completedEvent('unpaid'),
			step: runStep,
		})

		expect(result).toEqual({
			status: 'awaiting_payment',
			checkoutSessionId: SESSION_ID,
			productId: 'product_bank_transfer',
			amountTotal: 29_900,
		})
		expect(handler).not.toHaveBeenCalled()
		expect(record).toHaveBeenCalledTimes(1)
		expect(runStep.ran).toEqual(['record checkout awaiting delayed payment'])
	})

	it('runs the core handler unchanged for a paid completion', async () => {
		const handler = vi.fn(async (_input: unknown) => ({
			purchase: { id: 'purchase_1' },
		}))
		const record = vi.fn(async () => undefined)
		const input = { event: completedEvent('paid'), step: step() }

		expect(await guardUnpaidCheckoutCompletion(handler, record)(input)).toEqual({
			purchase: { id: 'purchase_1' },
		})
		expect(handler).toHaveBeenCalledWith(input)
		expect(record).not.toHaveBeenCalled()
	})
})

describe('fulfillAsyncPaidCheckout', () => {
	it('fulfills once; redelivery and a later reconciler pass are no-ops', async () => {
		const { deps, handler, purchases } = fixture()

		const first = await fulfillAsyncPaidCheckout(SESSION_ID, deps)
		expect(first).toMatchObject({
			status: 'fulfilled',
			checkoutSessionId: SESSION_ID,
			purchaseId: 'purchase_1',
		})
		expect(handler).toHaveBeenCalledTimes(1)

		// Stripe redelivers the async_payment_succeeded webhook.
		const redelivery = await fulfillAsyncPaidCheckout(SESSION_ID, {
			...deps,
			step: step(),
		})
		expect(redelivery).toMatchObject({
			status: 'already_fulfilled',
			purchaseIds: ['purchase_1'],
		})

		// The next sweep, past the reconciler's own 5-minute grace, finds the
		// purchase too.
		const reconciler = await fulfillCheckoutSessionDirectly(SESSION_ID, {
			...deps,
			step: step(),
			now: () => new Date(now.getTime() + 10 * 60_000),
			txnId: `aih-checkout-reconcile-${SESSION_ID}`,
		})
		expect(reconciler).toMatchObject({
			status: 'already_fulfilled',
			purchaseIds: ['purchase_1'],
		})

		expect(handler).toHaveBeenCalledTimes(1)
		expect([...purchases.values()]).toEqual(['purchase_1'])
	})

	it('fulfills a transfer that lands days after checkout opened', async () => {
		const opened = Math.floor(now.getTime() / 1000) - 5 * 24 * 3600
		const { deps } = fixture(session({ created: opened }))

		// The reconciler's 48-hour window would never see this session.
		expect(
			await fulfillCheckoutSessionDirectly(SESSION_ID, { ...deps, step: step() }),
		).toMatchObject({ status: 'skipped', reason: 'outside_window' })

		expect(await fulfillAsyncPaidCheckout(SESSION_ID, deps)).toMatchObject({
			status: 'fulfilled',
		})
	})

	it('fulfills a transfer the moment it lands, with no grace period', async () => {
		const justPaid = session()
		;(justPaid.payment_intent as any).latest_charge.created = Math.floor(
			now.getTime() / 1000,
		)
		const { deps } = fixture(justPaid)

		expect(await fulfillAsyncPaidCheckout(SESSION_ID, deps)).toMatchObject({
			status: 'fulfilled',
		})
	})

	it('creates nothing for a session that is still unpaid', async () => {
		const { deps, handler } = fixture(session({ payment_status: 'unpaid' }))

		expect(await fulfillAsyncPaidCheckout(SESSION_ID, deps)).toMatchObject({
			status: 'skipped',
			reason: 'not_paid',
		})
		expect(handler).not.toHaveBeenCalled()
	})
})
