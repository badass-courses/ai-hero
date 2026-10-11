/**
 * Checkout reconciler. Incident 2026-10-09: a paid checkout's Inngest event
 * was accepted and produced no run, silently, and the buyer waited two hours.
 *
 * `checkoutReconcilerSweep` runs every 10 minutes. It lists the last 48 hours
 * of completed Stripe Checkout Sessions (read-only), finds paid ones with no
 * purchase 5 minutes after payment, logs `checkout.reconcile.stranded` to
 * Axiom, and alerts the Slack ops channel on change, then hourly. With
 * auto-fulfill opted in, it requests one fulfillment per session.
 *
 * `checkoutReconcileFulfill` runs the registered
 * `stripe-checkout-session-completed` handler directly for one session, under
 * its own hourly idempotency key (`checkout-reconcile:<session id>:<hour>`),
 * with the guards in `fulfillCheckoutSessionDirectly`.
 *
 * Alert-only by default. `AIH_CHECKOUT_RECONCILER_AUTO_FULFILL=true` opts in
 * to fulfillment. The instant kill is pausing `checkout-reconcile-fulfill` in
 * the Inngest dashboard; the env var needs a redeploy.
 */
import { slackProvider } from '@/coursebuilder/slack-provider'
import { db } from '@/db'
import { env } from '@/env.mjs'
import { CHECKOUT_RECONCILE_FULFILL_EVENT } from '@/inngest/events/checkout-reconcile'
import { inngest } from '@/inngest/inngest.server'
import {
	findCheckoutHandler,
	fulfillCheckoutSessionDirectly,
	type CheckoutFulfillDatabase,
} from '@/lib/checkout-reconcile/fulfill'
import {
	findBuyerProductPurchaseIds,
	findFulfilledCheckoutSessionIds,
	inspectCheckoutFulfillment,
} from '@/lib/checkout-reconcile/inspect'
import {
	checkoutAutoFulfillEnabled,
	CHECKOUT_RECONCILE_AUTO_FULFILL_ENV,
	safeCheckoutErrorLabel,
	summarizeCheckoutSession,
} from '@/lib/checkout-reconcile/policy'
import {
	runCheckoutReconcileSweep,
	type StrandedCheckout,
} from '@/lib/checkout-reconcile/sweep'
import { AUTHORITATIVE_PRODUCT_IDS } from '@/lib/c5-pricing/decision'
import { log } from '@/server/logger'
import type { StripePaymentAdapter } from '@coursebuilder/commerce/stripe-provider'
import { courseBuilderCoreFunctions } from '@coursebuilder/server'

const MAX_LISTED_SESSIONS = 10_000

/** Mirrors the core checkout function's limit for the shared write key. */
function checkoutPurchaseWritesLimit() {
	const configured = Number(
		process.env.CB_INNGEST_CHECKOUT_CONCURRENCY_LIMIT ??
			process.env.CB_INNGEST_CONCURRENCY_LIMIT ??
			5,
	)
	return Number.isFinite(configured) && configured > 0 ? configured : 5
}

function paymentsAdapter(paymentProvider: unknown): StripePaymentAdapter {
	const adapter = (
		paymentProvider as
			| { options?: { paymentsAdapter?: Partial<StripePaymentAdapter> } }
			| undefined
	)?.options?.paymentsAdapter
	if (!adapter?.stripe || typeof adapter.getCheckoutSession !== 'function') {
		throw new Error('Checkout reconciler needs the Stripe payments adapter')
	}
	return adapter as StripePaymentAdapter
}

async function writeLog(
	level: 'info' | 'warn' | 'error',
	event: string,
	attrs: Record<string, unknown>,
) {
	await log[level](event, attrs)
}

async function sendOpsAlert(input: {
	title: string
	text: string
	color: string
}) {
	if (!slackProvider.defaultChannelId) {
		await log.warn('checkout.reconcile.slack_alert_skipped', {
			reason: 'missing-default-channel',
			title: input.title,
		})
		return
	}
	try {
		await slackProvider.sendNotification({
			channel: slackProvider.defaultChannelId,
			text: input.title,
			attachments: [
				{
					fallback: input.text,
					color: input.color,
					title: input.title,
					text: input.text,
				},
			],
		})
	} catch (error) {
		await log.error('checkout.reconcile.slack_alert_failed', {
			title: input.title,
			...safeCheckoutErrorLabel(error),
		})
	}
}

function describeStranded(item: StrandedCheckout) {
	const amount =
		item.amountTotal === null ? '?' : `$${(item.amountTotal / 100).toFixed(2)}`
	return `• \`${item.checkoutSessionId}\` ${amount}, paid ${item.ageMinutes} min ago${item.overdue ? ' *OVERDUE*' : ''}`
}

export const checkoutReconcilerSweep = inngest.createFunction(
	{
		id: 'checkout-reconciler-sweep',
		name: 'Checkout Reconciler Sweep',
		retries: 2,
		concurrency: {
			scope: 'env',
			key: '"checkout-reconciler-sweep"',
			limit: 1,
		},
	},
	{ cron: 'TZ=UTC */10 * * * *' },
	async ({ step, paymentProvider }) => {
		const stripe = paymentsAdapter(paymentProvider).stripe
		const autoFulfill = checkoutAutoFulfillEnabled()
		await step.run('reconcile expired gift reservations', async () => {
			const { recoverGiftReservations } = await import('@/lib/c5-pricing/gift-reservation-recovery-server')
			return recoverGiftReservations(stripe, new Date())
		})

		return runCheckoutReconcileSweep({
			step,
			now: () => new Date(),
			appName: env.NEXT_PUBLIC_APP_NAME,
			autoFulfill,
			listSessions: async (sinceUnix) => {
				const sessions = await stripe.checkout.sessions
					.list({
						created: { gte: sinceUnix },
						status: 'complete',
						limit: 100,
						// The charge, for the indexed purchase lookup, payment time,
						// and refund and dispute state, without a read per session.
						expand: ['data.payment_intent.latest_charge'],
					})
					.autoPagingToArray({ limit: MAX_LISTED_SESSIONS })
				return {
					sessions: sessions.map(summarizeCheckoutSession),
					truncated: sessions.length >= MAX_LISTED_SESSIONS,
				}
			},
			findFulfilled: async (sessions) => [
				...(await findFulfilledCheckoutSessionIds(db, sessions)),
			],
			log: writeLog,
			alert: async ({ stranded, held, autoFulfill, truncated }) => {
				const lines = [
					...stranded.map(describeStranded),
					...held.map(
						(item) => `${describeStranded(item)} (held: ${item.reason})`,
					),
				]
				const overdue = stranded.some((item) => item.overdue)
				const action = autoFulfill
					? overdue
						? 'Auto-fulfill was requested and has not landed; it retries hourly. Run `pnpm checkout:recover --checkout-session-id <id> --direct` (dry run first).'
						: 'Auto-fulfill requested through the same checkout handler.'
					: `Alert-only (${CHECKOUT_RECONCILE_AUTO_FULFILL_ENV} is not set). Run \`pnpm checkout:recover --checkout-session-id <id> --direct\` (dry run first).`
				await sendOpsAlert({
					title: `Paid checkout with no purchase: ${stranded.length + held.length}`,
					text: [
						...lines,
						action,
						...(held.length
							? ['Held sessions need a human: disputed, or the charge could not be read.']
							: []),
						...(truncated
							? [`The Stripe list hit its ${MAX_LISTED_SESSIONS} cap; older sessions were not checked.`]
							: []),
						'Repeats hourly while any remain.',
					].join('\n'),
					color: '#d92d20',
				})
			},
			requestFulfillment: async (requests) => {
				await step.sendEvent(
					'request stranded checkout fulfillment',
					requests.map((data) => ({
						name: CHECKOUT_RECONCILE_FULFILL_EVENT,
						data,
					})),
				)
			},
		})
	},
)

export const checkoutReconcileFulfill = inngest.createFunction(
	{
		id: 'checkout-reconcile-fulfill',
		name: 'Checkout Reconcile Fulfill',
		// Distinct from the core function's key (the bare session id), so a key
		// the dropped original event consumed cannot block this run. Bucketed
		// by hour; see `checkoutReconcileKey`.
		idempotency: 'event.data.reconcileKey',
		retries: 3,
		concurrency: [
			{ key: 'event.data.checkoutSessionId', limit: 1 },
			// The core checkout function's write throttle. Env-scoped keys are
			// shared across functions, so a burst of reconciles queues behind the
			// same limit as the originals.
			{
				scope: 'env',
				key: '"checkout-purchase-writes"',
				limit: checkoutPurchaseWritesLimit(),
			},
		],
		onFailure: async ({ event, error }) => {
			const checkoutSessionId = event.data.event.data.checkoutSessionId
			// No raw message: handler errors can carry the buyer's email. The
			// full error stays in the Inngest run.
			const label = safeCheckoutErrorLabel(error)
			await log.error('checkout.reconcile.fulfill_failed', {
				checkoutSessionId,
				...label,
			})
			await sendOpsAlert({
				title: 'Checkout reconciler could not fulfill a paid checkout',
				text: `\`${checkoutSessionId}\`: ${label.errorName}: ${label.errorSummary}\nFull error in the Inngest run. Run \`pnpm checkout:recover --checkout-session-id ${checkoutSessionId} --direct\` for a dry run first.`,
				color: '#d92d20',
			})
		},
	},
	{ event: CHECKOUT_RECONCILE_FULFILL_EVENT },
	async ({ event, step, db: adapter, paymentProvider, notificationProvider }) => {
		const { checkoutSessionId } = event.data
		if (!checkoutAutoFulfillEnabled()) {
			await step.run('record kill switch', () =>
				log.warn('checkout.reconcile.fulfill_disabled', { checkoutSessionId }),
			)
			return { status: 'disabled', checkoutSessionId }
		}

		const result = await fulfillCheckoutSessionDirectly(checkoutSessionId, {
			handler: findCheckoutHandler(courseBuilderCoreFunctions),
			step,
			db: adapter as unknown as CheckoutFulfillDatabase,
			paymentProvider,
			notificationProvider,
			getCheckoutSession: (id) =>
				paymentsAdapter(paymentProvider).getCheckoutSession(id),
			onPaidSession: async (session) => (await import('@/lib/c5-pricing/gift-settlement')).settleGiftSession(session),
			inspect: (input) => inspectCheckoutFulfillment(db, input),
			// C5 duplicates are fulfilled and flagged after payment, never held.
			holdsWhenBuyerHasProduct: (productId) =>
				!AUTHORITATIVE_PRODUCT_IDS.has(productId),
			findBuyerProductPurchases: (input) =>
				findBuyerProductPurchaseIds(db, input),
			appName: env.NEXT_PUBLIC_APP_NAME,
			now: () => new Date(),
			txnId: `aih-checkout-reconcile-${checkoutSessionId}`,
		})

		await step.run('record reconcile outcome', async () => {
			const level =
				result.status === 'held'
					? 'error'
					: result.status === 'skipped'
						? 'warn'
						: 'info'
			await log[level](`checkout.reconcile.${result.status}`, { ...result })
			if (result.status === 'fulfilled') {
				await sendOpsAlert({
					title: 'Checkout reconciler fulfilled a stranded checkout',
					text: `\`${checkoutSessionId}\` → purchase \`${result.purchaseId}\``,
					color: '#12b76a',
				})
			}
			if (result.status === 'held') {
				await sendOpsAlert({
					title: 'Checkout reconciler held a paid checkout',
					text: `\`${checkoutSessionId}\`: the buyer already has this product (purchase ${result.purchaseIds.map((id) => `\`${id}\``).join(', ')}), not from this checkout. Nothing was created. Check for a gift or hand fix, then link or refund.`,
					color: '#f79009',
				})
			}
			return null
		})
		return result
	},
)
