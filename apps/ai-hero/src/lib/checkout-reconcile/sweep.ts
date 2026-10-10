/**
 * The checkout reconciler sweep: find paid sessions with no purchase, alert,
 * and request one direct fulfillment per session.
 *
 * Stripe reads are list and retrieve only. The sweep never writes; the
 * fulfill function does, through `fulfillCheckoutSessionDirectly`.
 *
 * @module checkout-reconcile/sweep
 */
import type Stripe from 'stripe'

import {
	CHECKOUT_RECONCILE_OVERDUE_MS,
	CHECKOUT_RECONCILE_WINDOW_MS,
	checkoutChargeState,
	checkoutReconcileKey,
	classifyCheckoutSession,
	type CheckoutSessionSkipReason,
	type CheckoutSessionSummary,
} from './policy'

export type StrandedCheckout = {
	checkoutSessionId: string
	chargeId: string | null
	ageMinutes: number
	amountTotal: number | null
	overdue: boolean
}

export type CheckoutSweepStep = {
	run: <T>(id: string, fn: () => Promise<T>) => Promise<unknown>
}

export type CheckoutSweepDeps = {
	step: CheckoutSweepStep
	now: () => Date
	appName: string
	autoFulfill: boolean
	/** Paid-or-not sessions created at or after `sinceUnix`, all pages. */
	listSessions: (sinceUnix: number) => Promise<CheckoutSessionSummary[]>
	findFulfilled: (
		sessions: { checkoutSessionId: string; chargeId: string | null }[],
	) => Promise<string[]>
	getCheckoutSession: (
		checkoutSessionId: string,
	) => Promise<Stripe.Checkout.Session>
	log: (
		level: 'info' | 'warn' | 'error',
		event: string,
		attrs: Record<string, unknown>,
	) => Promise<void>
	alert: (input: {
		stranded: StrandedCheckout[]
		held: (StrandedCheckout & { reason: 'disputed' | 'charge_not_expanded' })[]
		autoFulfill: boolean
	}) => Promise<void>
	requestFulfillment: (
		requests: { checkoutSessionId: string; reconcileKey: string }[],
	) => Promise<void>
}

export type CheckoutSweepResult = {
	scanned: number
	candidates: number
	fulfilled: number
	skipped: Partial<Record<CheckoutSessionSkipReason, number>>
	stranded: StrandedCheckout[]
	refunded: string[]
	held: string[]
	requested: string[]
	autoFulfill: boolean
}

export async function runCheckoutReconcileSweep(
	deps: CheckoutSweepDeps,
): Promise<CheckoutSweepResult> {
	// Fixed in a step so every replay of this run classifies the same way.
	const startedAt = new Date(
		(await deps.step.run('start sweep', async () =>
			deps.now().getTime(),
		)) as number,
	)
	const sinceUnix = Math.floor(
		(startedAt.getTime() - CHECKOUT_RECONCILE_WINDOW_MS) / 1000,
	)

	const sessions = (await deps.step.run('list completed checkout sessions', () =>
		deps.listSessions(sinceUnix),
	)) as CheckoutSessionSummary[]

	const skipped: Partial<Record<CheckoutSessionSkipReason, number>> = {}
	const candidates: { session: CheckoutSessionSummary; ageMs: number }[] = []
	for (const session of sessions) {
		const verdict = classifyCheckoutSession(session, {
			now: startedAt,
			appName: deps.appName,
		})
		if (verdict.kind === 'skip') {
			skipped[verdict.reason] = (skipped[verdict.reason] ?? 0) + 1
		} else {
			candidates.push({ session, ageMs: verdict.ageMs })
		}
	}

	const fulfilled = new Set(
		candidates.length
			? ((await deps.step.run('find fulfilled checkout sessions', () =>
					deps.findFulfilled(
						candidates.map(({ session }) => ({
							checkoutSessionId: session.id,
							chargeId: session.chargeId,
						})),
					),
				)) as string[])
			: [],
	)
	const unfulfilled = candidates.filter(
		({ session }) => !fulfilled.has(session.id),
	)

	const stranded: StrandedCheckout[] = []
	const refunded: (StrandedCheckout & { amountRefunded: number })[] = []
	const held: (StrandedCheckout & {
		reason: 'disputed' | 'charge_not_expanded'
	})[] = []

	for (const { session, ageMs } of unfulfilled) {
		const charge = (await deps.step.run(
			`check charge for ${session.id}`,
			async () =>
				checkoutChargeState(await deps.getCheckoutSession(session.id)),
		)) as ReturnType<typeof checkoutChargeState>
		const item: StrandedCheckout = {
			checkoutSessionId: session.id,
			chargeId: charge.chargeId,
			ageMinutes: Math.floor(ageMs / 60_000),
			amountTotal: session.amountTotal,
			overdue: ageMs >= CHECKOUT_RECONCILE_OVERDUE_MS,
		}
		if (charge.refunded) {
			refunded.push({ ...item, amountRefunded: charge.amountRefunded })
		} else if (charge.disputed || !charge.expanded) {
			held.push({
				...item,
				reason: charge.disputed ? 'disputed' : 'charge_not_expanded',
			})
		} else {
			stranded.push(item)
		}
	}

	// Inngest re-runs this code once per completed step, so logs and alerts
	// live inside one step to fire once per sweep.
	if (stranded.length || held.length || refunded.length) {
		await deps.step.run('record stranded checkouts', async () => {
			for (const item of refunded)
				await deps.log('info', 'checkout.reconcile.refunded_skipped', item)
			for (const item of held)
				await deps.log('warn', 'checkout.reconcile.held', item)
			for (const item of stranded) {
				const attrs = { ...item, autoFulfill: deps.autoFulfill }
				await deps.log('error', 'checkout.reconcile.stranded', attrs)
				if (item.overdue)
					await deps.log('error', 'checkout.reconcile.fulfill_overdue', attrs)
			}
			if (stranded.length || held.length)
				await deps.alert({ stranded, held, autoFulfill: deps.autoFulfill })
			return null
		})
	}

	// Every stranded session is requested, overdue ones too: a sweep that
	// missed ticks may see a session for the first time after 30 minutes. A
	// repeat request for the same session is dropped by the fulfill
	// function's idempotency key, so the alert carries the escalation.
	const requests = deps.autoFulfill
		? stranded.map((item) => ({
				checkoutSessionId: item.checkoutSessionId,
				reconcileKey: checkoutReconcileKey(item.checkoutSessionId),
			}))
		: []
	if (requests.length) await deps.requestFulfillment(requests)

	const result: CheckoutSweepResult = {
		scanned: sessions.length,
		candidates: candidates.length,
		fulfilled: fulfilled.size,
		skipped,
		stranded,
		refunded: refunded.map((item) => item.checkoutSessionId),
		held: held.map((item) => item.checkoutSessionId),
		requested: requests.map((request) => request.checkoutSessionId),
		autoFulfill: deps.autoFulfill,
	}
	const summary = {
		scanned: result.scanned,
		candidates: result.candidates,
		fulfilled: result.fulfilled,
		stranded: stranded.length,
		refunded: refunded.length,
		held: held.length,
		requested: requests.length,
		autoFulfill: deps.autoFulfill,
	}
	await deps.step.run('record sweep summary', async () => {
		await deps.log('info', 'checkout.reconcile.sweep', summary)
		return null
	})
	return result
}
