import { describe, expect, it, vi } from 'vitest'

import type { CheckoutSessionSummary } from './policy'
import { runCheckoutReconcileSweep, type CheckoutSweepDeps } from './sweep'

const now = new Date('2026-10-09T22:00:00Z')
const minutesAgo = (minutes: number) =>
	Math.floor(now.getTime() / 1000) - minutes * 60

function summary(
	id: string,
	overrides: Partial<CheckoutSessionSummary> = {},
): CheckoutSessionSummary {
	return {
		id,
		created: minutesAgo(12),
		mode: 'payment',
		status: 'complete',
		paymentStatus: 'paid',
		amountTotal: 29_900,
		siteName: 'ai-hero',
		chargeId: `ch_${id}`,
		...overrides,
	}
}

function chargeSession(
	id: string,
	charge: { refunded?: boolean; amount_refunded?: number; disputed?: boolean },
) {
	return {
		id,
		payment_intent: {
			latest_charge: {
				id: `ch_${id}`,
				refunded: false,
				amount_refunded: 0,
				disputed: false,
				...charge,
			},
		},
	}
}

function harness(
	sessions: CheckoutSessionSummary[],
	options: {
		fulfilled?: string[]
		charges?: Record<string, Parameters<typeof chargeSession>[1]>
		autoFulfill?: boolean
	} = {},
) {
	const stepIds: string[] = []
	const deps = {
		step: {
			run: vi.fn(async (id: string, fn: () => Promise<unknown>) => {
				stepIds.push(id)
				return fn()
			}),
		},
		now: () => now,
		appName: 'ai-hero',
		autoFulfill: options.autoFulfill ?? true,
		listSessions: vi.fn(async () => sessions),
		findFulfilled: vi.fn(async () => options.fulfilled ?? []),
		getCheckoutSession: vi.fn(async (id: string) =>
			chargeSession(id, options.charges?.[id] ?? {}),
		),
		log: vi.fn(
			async (_level: string, _event: string, _attrs: Record<string, unknown>) => {},
		),
		alert: vi.fn(async (_input: unknown) => {}),
		requestFulfillment: vi.fn(async () => {}),
	}
	return { deps: deps as unknown as CheckoutSweepDeps & typeof deps, stepIds }
}

describe('checkout reconciler sweep', () => {
	it('alerts and requests one fulfillment for a stranded paid session', async () => {
		const { deps } = harness([summary('cs_stranded')])
		const result = await runCheckoutReconcileSweep(deps)

		expect(result.stranded).toEqual([
			{
				checkoutSessionId: 'cs_stranded',
				chargeId: 'ch_cs_stranded',
				ageMinutes: 12,
				amountTotal: 29_900,
				overdue: false,
			},
		])
		expect(deps.log).toHaveBeenCalledWith(
			'error',
			'checkout.reconcile.stranded',
			expect.objectContaining({ checkoutSessionId: 'cs_stranded' }),
		)
		expect(deps.alert).toHaveBeenCalledTimes(1)
		expect(deps.requestFulfillment).toHaveBeenCalledWith([
			{
				checkoutSessionId: 'cs_stranded',
				reconcileKey: 'checkout-reconcile:cs_stranded',
			},
		])
	})

	it('leaves fulfilled sessions untouched and never reads their charge', async () => {
		const { deps } = harness([summary('cs_done')], { fulfilled: ['cs_done'] })
		const result = await runCheckoutReconcileSweep(deps)

		expect(deps.findFulfilled).toHaveBeenCalledWith([
			{ checkoutSessionId: 'cs_done', chargeId: 'ch_cs_done' },
		])
		expect(result).toMatchObject({ fulfilled: 1, stranded: [], requested: [] })
		expect(deps.getCheckoutSession).not.toHaveBeenCalled()
		expect(deps.alert).not.toHaveBeenCalled()
		expect(deps.requestFulfillment).not.toHaveBeenCalled()
	})

	it('ignores unpaid, expired and too-young sessions without a database read', async () => {
		const { deps } = harness([
			summary('cs_unpaid', { paymentStatus: 'unpaid' }),
			summary('cs_expired', { status: 'expired', paymentStatus: 'unpaid' }),
			summary('cs_young', { created: minutesAgo(2) }),
		])
		const result = await runCheckoutReconcileSweep(deps)

		expect(result.skipped).toEqual({
			not_paid: 1,
			not_complete: 1,
			too_young: 1,
		})
		expect(deps.findFulfilled).not.toHaveBeenCalled()
		expect(deps.requestFulfillment).not.toHaveBeenCalled()
	})

	it('ignores and logs a refunded session without alerting or fulfilling', async () => {
		const { deps } = harness([summary('cs_refunded')], {
			charges: { cs_refunded: { refunded: true, amount_refunded: 29_900 } },
		})
		const result = await runCheckoutReconcileSweep(deps)

		expect(result.refunded).toEqual(['cs_refunded'])
		expect(deps.log).toHaveBeenCalledWith(
			'info',
			'checkout.reconcile.refunded_skipped',
			expect.objectContaining({
				checkoutSessionId: 'cs_refunded',
				amountRefunded: 29_900,
			}),
		)
		expect(deps.alert).not.toHaveBeenCalled()
		expect(deps.requestFulfillment).not.toHaveBeenCalled()
	})

	it('holds a disputed session for a human', async () => {
		const { deps } = harness([summary('cs_disputed')], {
			charges: { cs_disputed: { disputed: true } },
		})
		const result = await runCheckoutReconcileSweep(deps)

		expect(result.held).toEqual(['cs_disputed'])
		expect(deps.alert).toHaveBeenCalledWith(
			expect.objectContaining({
				stranded: [],
				held: [expect.objectContaining({ reason: 'disputed' })],
			}),
		)
		expect(deps.requestFulfillment).not.toHaveBeenCalled()
	})

	it('alerts without fulfilling when the kill switch is on', async () => {
		const { deps } = harness([summary('cs_stranded')], { autoFulfill: false })
		const result = await runCheckoutReconcileSweep(deps)

		expect(result.stranded).toHaveLength(1)
		expect(deps.alert).toHaveBeenCalledWith(
			expect.objectContaining({ autoFulfill: false }),
		)
		expect(deps.requestFulfillment).not.toHaveBeenCalled()
	})

	it('escalates a session still stranded after 30 minutes', async () => {
		const { deps } = harness([summary('cs_old', { created: minutesAgo(45) })])
		const result = await runCheckoutReconcileSweep(deps)

		expect(result.stranded[0]?.overdue).toBe(true)
		expect(deps.log).toHaveBeenCalledWith(
			'error',
			'checkout.reconcile.fulfill_overdue',
			expect.objectContaining({ checkoutSessionId: 'cs_old' }),
		)
		// Requested anyway: a sweep that missed ticks may see it for the first
		// time now, and a repeat is dropped by the fulfill idempotency key.
		expect(deps.requestFulfillment).toHaveBeenCalledTimes(1)
	})

	it('logs and alerts only inside steps, so Inngest replays do not repeat them', async () => {
		const { deps } = harness([summary('cs_stranded')])
		let insideStep = false
		deps.step.run.mockImplementation(async (_id, fn) => {
			insideStep = true
			try {
				return await fn()
			} finally {
				insideStep = false
			}
		})
		const outside: string[] = []
		deps.log.mockImplementation(async (_level, event) => {
			if (!insideStep) outside.push(event)
		})
		deps.alert.mockImplementation(async () => {
			if (!insideStep) outside.push('alert')
		})
		await runCheckoutReconcileSweep(deps)
		expect(outside).toEqual([])
	})
})
