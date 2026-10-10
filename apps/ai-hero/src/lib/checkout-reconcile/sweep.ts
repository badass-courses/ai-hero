/**
 * The checkout reconciler sweep: find paid sessions with no purchase, alert,
 * and request one direct fulfillment per session.
 *
 * Stripe reads are one paginated list call, with each session's charge
 * expanded, so refund, dispute and payment time come back with it. The sweep
 * never writes; the fulfill function does, through
 * `fulfillCheckoutSessionDirectly`, and only when auto-fulfill is opted in.
 *
 * @module checkout-reconcile/sweep
 */
import {
	CHECKOUT_RECONCILE_MIN_AGE_MS,
	CHECKOUT_RECONCILE_OVERDUE_MS,
	CHECKOUT_RECONCILE_SWEEP_INTERVAL_MS,
	CHECKOUT_RECONCILE_WINDOW_MS,
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

export type HeldCheckout = StrandedCheckout & {
	reason: 'disputed' | 'charge_not_expanded'
}

export type CheckoutSweepStep = {
	run: <T>(id: string, fn: () => Promise<T>) => Promise<unknown>
}

export type CheckoutSessionListing = {
	sessions: CheckoutSessionSummary[]
	/** True when the list hit its cap, so older sessions were not read. */
	truncated: boolean
}

export type CheckoutSweepDeps = {
	step: CheckoutSweepStep
	now: () => Date
	appName: string
	autoFulfill: boolean
	/** Completed sessions created at or after `sinceUnix`, all pages. */
	listSessions: (sinceUnix: number) => Promise<CheckoutSessionListing>
	findFulfilled: (
		sessions: { checkoutSessionId: string; chargeId: string | null }[],
	) => Promise<string[]>
	log: (
		level: 'info' | 'warn' | 'error',
		event: string,
		attrs: Record<string, unknown>,
	) => Promise<void>
	alert: (input: {
		stranded: StrandedCheckout[]
		held: HeldCheckout[]
		autoFulfill: boolean
		truncated: boolean
	}) => Promise<void>
	requestFulfillment: (
		requests: { checkoutSessionId: string; reconcileKey: string }[],
	) => Promise<void>
}

export type CheckoutSweepResult = {
	scanned: number
	truncated: boolean
	candidates: number
	fulfilled: number
	skipped: Partial<Record<CheckoutSessionSkipReason, number>>
	stranded: StrandedCheckout[]
	refunded: string[]
	held: string[]
	requested: string[]
	alerted: boolean
	autoFulfill: boolean
}

/** True when `ageMs` crossed `line` since the previous tick. */
function crossedSinceLastTick(ageMs: number, line: number) {
	return ageMs >= line && ageMs < line + CHECKOUT_RECONCILE_SWEEP_INTERVAL_MS
}

/**
 * Alert on change, then hourly. The sweep keeps no state between ticks, so
 * "change" means a session crossed the 5-minute line (newly stranded) or the
 * 30-minute line (overdue) since the previous tick. While any session stays
 * stranded or held, the first tick of each UTC hour repeats the alert. A tick
 * that ran late can miss a crossing; the hourly reminder bounds that delay.
 */
export function shouldAlert(
	items: { ageMs: number }[],
	startedAt: Date,
	truncated: boolean,
) {
	const hourlyTick =
		startedAt.getUTCMinutes() * 60_000 < CHECKOUT_RECONCILE_SWEEP_INTERVAL_MS
	if (hourlyTick && (items.length > 0 || truncated)) return true
	return items.some(
		({ ageMs }) =>
			crossedSinceLastTick(ageMs, CHECKOUT_RECONCILE_MIN_AGE_MS) ||
			crossedSinceLastTick(ageMs, CHECKOUT_RECONCILE_OVERDUE_MS),
	)
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

	// Classified inside the step, so step output carries candidates only and
	// stays small at launch volume. `startedAt` is memoized, so replays agree.
	const listing = (await deps.step.run(
		'list completed checkout sessions',
		async () => {
			const { sessions, truncated } = await deps.listSessions(sinceUnix)
			const skipped: Partial<Record<CheckoutSessionSkipReason, number>> = {}
			const candidates: { session: CheckoutSessionSummary; ageMs: number }[] =
				[]
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
			return { scanned: sessions.length, truncated, skipped, candidates }
		},
	)) as {
		scanned: number
		truncated: boolean
		skipped: Partial<Record<CheckoutSessionSkipReason, number>>
		candidates: { session: CheckoutSessionSummary; ageMs: number }[]
	}
	const { candidates, skipped, truncated } = listing

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
	const held: HeldCheckout[] = []
	const alertable: { ageMs: number }[] = []

	for (const { session, ageMs } of unfulfilled) {
		const charge = session.charge
		const item: StrandedCheckout = {
			checkoutSessionId: session.id,
			chargeId: charge.chargeId,
			ageMinutes: Math.floor(ageMs / 60_000),
			amountTotal: session.amountTotal,
			overdue: ageMs >= CHECKOUT_RECONCILE_OVERDUE_MS,
		}
		if (charge.refunded) {
			refunded.push({ ...item, amountRefunded: charge.amountRefunded })
			continue
		}
		if (charge.disputed || !charge.expanded) {
			held.push({
				...item,
				reason: charge.disputed ? 'disputed' : 'charge_not_expanded',
			})
		} else {
			stranded.push(item)
		}
		alertable.push({ ageMs })
	}

	const alerted =
		stranded.length + held.length > 0 || truncated
			? shouldAlert(alertable, startedAt, truncated)
			: false

	// Inngest re-runs this code once per completed step, so logs and alerts
	// live inside one step to fire once per sweep.
	if (stranded.length || held.length || refunded.length || truncated) {
		await deps.step.run('record stranded checkouts', async () => {
			if (truncated)
				await deps.log('error', 'checkout.reconcile.list_truncated', {
					scanned: listing.scanned,
				})
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
			if (alerted)
				await deps.alert({
					stranded,
					held,
					autoFulfill: deps.autoFulfill,
					truncated,
				})
			return null
		})
	}

	// Every stranded session is requested, overdue ones too: a sweep that
	// missed ticks may see a session for the first time after 30 minutes. The
	// fulfill function's hourly key drops repeats within the hour, so a
	// session that is still stranded gets one new attempt per hour.
	const requests = deps.autoFulfill
		? stranded.map((item) => ({
				checkoutSessionId: item.checkoutSessionId,
				reconcileKey: checkoutReconcileKey(item.checkoutSessionId, startedAt),
			}))
		: []
	if (requests.length) await deps.requestFulfillment(requests)

	const result: CheckoutSweepResult = {
		scanned: listing.scanned,
		truncated,
		candidates: candidates.length,
		fulfilled: fulfilled.size,
		skipped,
		stranded,
		refunded: refunded.map((item) => item.checkoutSessionId),
		held: held.map((item) => item.checkoutSessionId),
		requested: requests.map((request) => request.checkoutSessionId),
		alerted,
		autoFulfill: deps.autoFulfill,
	}
	const summary = {
		scanned: result.scanned,
		truncated,
		candidates: result.candidates,
		fulfilled: result.fulfilled,
		stranded: stranded.length,
		refunded: refunded.length,
		held: held.length,
		requested: requests.length,
		alerted,
		autoFulfill: deps.autoFulfill,
	}
	await deps.step.run('record sweep summary', async () => {
		await deps.log('info', 'checkout.reconcile.sweep', summary)
		return null
	})
	return result
}
