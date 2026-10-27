import { describe, expect, it, vi } from 'vitest'

import type { CheckoutSessionSummary } from './policy'
import { runCheckoutReconcileSweep, type CheckoutSweepDeps } from './sweep'

// Not the first tick of an hour, so only a crossing alerts.
const now = new Date('2026-10-09T22:04:00Z')
const minutesAgo = (minutes: number, at = now) =>
	Math.floor(at.getTime() / 1000) - minutes * 60

type ChargeOverrides = {
	refunded?: boolean
	amountRefunded?: number
	disputed?: boolean
	expanded?: boolean
}

function summary(
	id: string,
	overrides: Partial<CheckoutSessionSummary> & { paidMinutesAgo?: number } = {},
	charge: ChargeOverrides = {},
	at = now,
): CheckoutSessionSummary {
	const { paidMinutesAgo = 12, ...rest } = overrides
	const amountRefunded = charge.amountRefunded ?? 0
	return {
		id,
		created: minutesAgo(paidMinutesAgo + 1, at),
		mode: 'payment',
		status: 'complete',
		paymentStatus: 'paid',
		amountTotal: 29_900,
		siteName: 'ai-hero',
		chargeId: `ch_${id}`,
		paidAt: minutesAgo(paidMinutesAgo, at),
		charge: {
			chargeId: `ch_${id}`,
			expanded: charge.expanded ?? true,
			refunded: (charge.refunded ?? false) || amountRefunded > 0,
			disputed: charge.disputed ?? false,
			amountRefunded,
		},
		...rest,
	}
}

function harness(
	sessions: CheckoutSessionSummary[],
	options: {
		fulfilled?: string[]
		autoFulfill?: boolean
		truncated?: boolean
		at?: Date
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
		now: () => options.at ?? now,
		appName: 'ai-hero',
		autoFulfill: options.autoFulfill ?? true,
		listSessions: vi.fn(async () => ({
			sessions,
			truncated: options.truncated ?? false,
		})),
		findFulfilled: vi.fn(async () => options.fulfilled ?? []),
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
				reconcileKey: 'checkout-reconcile:cs_stranded:2026100922',
			},
		])
	})

	it('reads charge state from the list call, with no Stripe read per session', async () => {
		const { deps, stepIds } = harness([
			summary('cs_a'),
			summary('cs_b'),
			summary('cs_c', {}, { disputed: true }),
		])
		await runCheckoutReconcileSweep(deps)
		expect(stepIds).toEqual([
			'start sweep',
			'list completed checkout sessions',
			'find fulfilled checkout sessions',
			'record stranded checkouts',
			'record sweep summary',
		])
	})

	it('leaves fulfilled sessions untouched', async () => {
		const { deps } = harness([summary('cs_done')], { fulfilled: ['cs_done'] })
		const result = await runCheckoutReconcileSweep(deps)

		expect(deps.findFulfilled).toHaveBeenCalledWith([
			{ checkoutSessionId: 'cs_done', chargeId: 'ch_cs_done' },
		])
		expect(result).toMatchObject({ fulfilled: 1, stranded: [], requested: [] })
		expect(deps.alert).not.toHaveBeenCalled()
		expect(deps.requestFulfillment).not.toHaveBeenCalled()
	})

	it('ignores unpaid, expired and too-young sessions without a database read', async () => {
		const { deps } = harness([
			summary('cs_unpaid', { paymentStatus: 'unpaid' }),
			summary('cs_expired', { status: 'expired', paymentStatus: 'unpaid' }),
			summary('cs_young', { paidMinutesAgo: 2 }),
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
		const { deps } = harness([
			summary('cs_refunded', {}, { refunded: true, amountRefunded: 29_900 }),
		])
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
		const { deps } = harness([summary('cs_disputed', {}, { disputed: true })])
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

	it('alerts without fulfilling in alert-only mode', async () => {
		const { deps } = harness([summary('cs_stranded')], { autoFulfill: false })
		const result = await runCheckoutReconcileSweep(deps)

		expect(result.stranded).toHaveLength(1)
		expect(deps.alert).toHaveBeenCalledWith(
			expect.objectContaining({ autoFulfill: false }),
		)
		expect(deps.requestFulfillment).not.toHaveBeenCalled()
	})

	it('escalates a session still stranded 30 minutes after payment', async () => {
		const { deps } = harness([summary('cs_old', { paidMinutesAgo: 35 })])
		const result = await runCheckoutReconcileSweep(deps)

		expect(result.stranded[0]?.overdue).toBe(true)
		expect(deps.log).toHaveBeenCalledWith(
			'error',
			'checkout.reconcile.fulfill_overdue',
			expect.objectContaining({ checkoutSessionId: 'cs_old' }),
		)
		expect(deps.alert).toHaveBeenCalledTimes(1)
		// Requested anyway: a sweep that missed ticks may see it for the first
		// time now, and the hourly key drops repeats within the hour.
		expect(deps.requestFulfillment).toHaveBeenCalledTimes(1)
	})

	it('does not call a slow checkout overdue the moment it is paid', async () => {
		// Opened 40 minutes ago, paid 6 minutes ago.
		const { deps } = harness([
			summary('cs_slow', { created: minutesAgo(40), paidMinutesAgo: 6 }),
		])
		const result = await runCheckoutReconcileSweep(deps)
		expect(result.stranded[0]).toMatchObject({ ageMinutes: 6, overdue: false })
	})

	it('alerts on change, then only on the first tick of each hour', async () => {
		// 25 minutes after payment: no line crossed since the last tick.
		const at = new Date('2026-10-09T22:24:00Z')
		const quiet = harness([summary('cs_waiting', { paidMinutesAgo: 25 }, {}, at)], {
			at,
		})
		const quietResult = await runCheckoutReconcileSweep(quiet.deps)
		expect(quietResult).toMatchObject({ alerted: false })
		expect(quiet.deps.alert).not.toHaveBeenCalled()
		// Still logged and still requested every tick.
		expect(quiet.deps.log).toHaveBeenCalledWith(
			'error',
			'checkout.reconcile.stranded',
			expect.objectContaining({ checkoutSessionId: 'cs_waiting' }),
		)
		expect(quiet.deps.requestFulfillment).toHaveBeenCalledTimes(1)

		const hourly = new Date('2026-10-09T23:02:00Z')
		const reminder = harness(
			[summary('cs_waiting', { paidMinutesAgo: 63 }, {}, hourly)],
			{ at: hourly },
		)
		expect(await runCheckoutReconcileSweep(reminder.deps)).toMatchObject({
			alerted: true,
		})
		expect(reminder.deps.alert).toHaveBeenCalledTimes(1)
	})

	it('logs and alerts when the Stripe list hit its cap', async () => {
		const hourly = new Date('2026-10-09T23:01:00Z')
		const { deps } = harness([], { truncated: true, at: hourly })
		const result = await runCheckoutReconcileSweep(deps)

		expect(result.truncated).toBe(true)
		expect(deps.log).toHaveBeenCalledWith(
			'error',
			'checkout.reconcile.list_truncated',
			{ scanned: 0 },
		)
		expect(deps.log).toHaveBeenCalledWith(
			'info',
			'checkout.reconcile.sweep',
			expect.objectContaining({ truncated: true }),
		)
		expect(deps.alert).toHaveBeenCalledWith(
			expect.objectContaining({ truncated: true }),
		)
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
