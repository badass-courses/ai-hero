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
	metadata: { siteName: 'ai-hero' },
	mode: 'payment',
	payment_intent: {
		id: 'pi_recovery',
		latest_charge: {
			id: 'ch_recovery',
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

const fulfilledState: CheckoutRecoveryState = {
	chargeIds: ['mc_recovery'],
	merchantSessionIds: ['ms_recovery'],
	purchaseIds: ['purch_direct'],
}

function runtime(
	state: CheckoutRecoveryState = intermediateState,
	options: { replayRuns?: number | null; appName?: string | null } = {},
): CheckoutRecoveryRuntime & {
	getCheckoutSession: ReturnType<typeof vi.fn>
	sendReplay: ReturnType<typeof vi.fn>
	countReplayRuns: ReturnType<typeof vi.fn>
	fulfillDirect: ReturnType<typeof vi.fn>
} {
	return {
		appName: options.appName === undefined ? 'ai-hero' : options.appName,
		getCheckoutSession: vi.fn().mockResolvedValue(session),
		inspect: vi.fn().mockResolvedValue(state),
		sendReplay: vi.fn().mockResolvedValue({ ids: ['evt_inngest_recovery'] }),
		countReplayRuns: vi
			.fn()
			.mockResolvedValue(
				options.replayRuns === undefined ? 1 : options.replayRuns,
			),
		fulfillDirect: vi.fn().mockResolvedValue({
			status: 'fulfilled',
			checkoutSessionId: session.id,
			chargeId: 'ch_recovery',
			purchaseId: 'purch_direct',
			state: fulfilledState,
		}),
		close: vi.fn().mockResolvedValue(undefined),
	}
}

const args = (overrides: { apply?: boolean; direct?: boolean } = {}) => ({
	checkoutSessionId: session.id,
	apply: false,
	direct: false,
	...overrides,
})

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
			direct: false,
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
			args(),
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
			args({ apply: true }),
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
			args({ apply: true }),
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
			args({ apply: true }),
			testRuntime,
		)

		expect(receipt).toMatchObject({ status: 'refused', success: false })
		expect(testRuntime.sendReplay).not.toHaveBeenCalled()
	})

	it('refuses a refunded session in every mode', async () => {
		for (const mode of [args({ apply: true }), args({ apply: true, direct: true })]) {
			const testRuntime = runtime()
			testRuntime.getCheckoutSession = vi.fn().mockResolvedValue({
				...session,
				payment_intent: {
					id: 'pi_recovery',
					latest_charge: {
						id: 'ch_recovery',
						refunded: true,
						amount_refunded: 19_900,
						disputed: false,
					},
				},
			})
			const receipt = await runCheckoutRecovery(mode, testRuntime)

			expect(receipt).toMatchObject({
				status: 'refused',
				reason: 'Checkout charge is refunded',
			})
			expect(testRuntime.sendReplay).not.toHaveBeenCalled()
			expect(testRuntime.fulfillDirect).not.toHaveBeenCalled()
		}
	})

	it('keeps the replay when Inngest ran it', async () => {
		const testRuntime = runtime(intermediateState, { replayRuns: 1 })
		const receipt = await runCheckoutRecovery(args({ apply: true }), testRuntime)

		expect(receipt).toMatchObject({
			status: 'replay_requested',
			success: true,
			replayRunCount: 1,
			directReason: null,
		})
		expect(testRuntime.countReplayRuns).toHaveBeenCalledWith([
			'evt_inngest_recovery',
		])
		expect(testRuntime.fulfillDirect).not.toHaveBeenCalled()
	})

	it('runs the handler directly when the replay produced no run', async () => {
		const testRuntime = runtime(intermediateState, { replayRuns: 0 })
		const receipt = await runCheckoutRecovery(args({ apply: true }), testRuntime)

		expect(receipt).toMatchObject({
			version: 2,
			status: 'fulfilled_direct',
			success: true,
			directReason: 'replay_produced_no_run',
			replayRunCount: 0,
			inngestEventIds: ['evt_inngest_recovery'],
			purchaseId: 'purch_direct',
			state: fulfilledState,
		})
		expect(testRuntime.fulfillDirect).toHaveBeenCalledTimes(1)
		expect(testRuntime.fulfillDirect).toHaveBeenCalledWith(session.id)
	})

	it('says so when it cannot verify the replay run', async () => {
		const testRuntime = runtime(intermediateState, { replayRuns: null })
		const receipt = await runCheckoutRecovery(args({ apply: true }), testRuntime)

		expect(receipt).toMatchObject({
			status: 'replay_requested',
			success: true,
			replayRunCount: null,
		})
		expect(receipt.reason).toMatch(/--direct/)
		expect(testRuntime.fulfillDirect).not.toHaveBeenCalled()
	})

	it('reports a direct run without writing in dry-run', async () => {
		const testRuntime = runtime()
		const receipt = await runCheckoutRecovery(args({ direct: true }), testRuntime)

		expect(receipt).toMatchObject({
			mode: 'dry-run',
			status: 'would_fulfill_direct',
			success: true,
			directReason: 'requested',
			chargeId: 'ch_recovery',
		})
		expect(testRuntime.sendReplay).not.toHaveBeenCalled()
		expect(testRuntime.fulfillDirect).not.toHaveBeenCalled()
	})

	it('skips the replay and runs the handler once with --direct --apply', async () => {
		const testRuntime = runtime()
		const receipt = await runCheckoutRecovery(
			args({ apply: true, direct: true }),
			testRuntime,
		)

		expect(receipt).toMatchObject({
			status: 'fulfilled_direct',
			success: true,
			directReason: 'requested',
			purchaseId: 'purch_direct',
			inngestEventIds: [],
		})
		expect(testRuntime.sendReplay).not.toHaveBeenCalled()
		expect(testRuntime.fulfillDirect).toHaveBeenCalledTimes(1)
	})

	it('reports a race the direct run lost as already recovered', async () => {
		const testRuntime = runtime()
		testRuntime.fulfillDirect.mockResolvedValue({
			status: 'raced',
			checkoutSessionId: session.id,
			chargeId: 'ch_recovery',
			purchaseIds: ['purch_original'],
			state: { ...fulfilledState, purchaseIds: ['purch_original'] },
		})
		const receipt = await runCheckoutRecovery(
			args({ apply: true, direct: true }),
			testRuntime,
		)

		expect(receipt).toMatchObject({
			status: 'already_recovered',
			success: true,
			purchaseId: 'purch_original',
			reason: 'Another run created the purchase first',
		})
	})

	it('refuses a held direct run: the buyer got the product another way', async () => {
		const testRuntime = runtime()
		testRuntime.fulfillDirect.mockResolvedValue({
			status: 'held',
			checkoutSessionId: session.id,
			chargeId: 'ch_recovery',
			reason: 'buyer_already_has_product',
			purchaseIds: ['purch_gift'],
		})
		const receipt = await runCheckoutRecovery(
			args({ apply: true, direct: true }),
			testRuntime,
		)

		expect(receipt).toMatchObject({
			status: 'refused',
			success: false,
			purchaseId: 'purch_gift',
		})
		expect(receipt.reason).toContain('buyer_already_has_product')
	})

	it('predicts in dry-run what a direct apply would refuse', async () => {
		const otherSite = runtime()
		otherSite.getCheckoutSession.mockResolvedValue({
			...session,
			metadata: { siteName: 'some-other-app' },
		})
		expect(
			await runCheckoutRecovery(args({ direct: true }), otherSite),
		).toMatchObject({
			status: 'refused',
			reason: 'Direct fulfillment skipped: other_site',
		})

		const zeroTotal = runtime()
		zeroTotal.getCheckoutSession.mockResolvedValue({ ...session, amount_total: 0 })
		expect(
			await runCheckoutRecovery(args({ direct: true }), zeroTotal),
		).toMatchObject({
			status: 'refused',
			reason: 'Direct fulfillment skipped: zero_total',
		})

		const noAppName = runtime(intermediateState, { appName: null })
		expect(
			await runCheckoutRecovery(args({ direct: true }), noAppName),
		).toMatchObject({ status: 'refused' })
		for (const testRuntime of [otherSite, zeroTotal, noAppName])
			expect(testRuntime.fulfillDirect).not.toHaveBeenCalled()
	})

	it('never runs the handler directly once a purchase exists', async () => {
		const testRuntime = runtime(fulfilledState)
		const receipt = await runCheckoutRecovery(
			args({ apply: true, direct: true }),
			testRuntime,
		)

		expect(receipt.status).toBe('already_recovered')
		expect(testRuntime.fulfillDirect).not.toHaveBeenCalled()
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
			direct: false,
			receiptPath: 'tmp/receipt.json',
		})
		expect(
			parseCheckoutRecoveryArgs([
				'--checkout-session-id',
				'cs_live_recovery1',
				'--direct',
			]),
		).toMatchObject({ apply: false, direct: true })
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
