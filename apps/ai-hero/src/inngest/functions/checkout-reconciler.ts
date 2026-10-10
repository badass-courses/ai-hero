/**
 * Checkout reconciler. Incident 2026-10-09: a paid checkout's Inngest event
 * was accepted and produced no run, silently, and the buyer waited two hours.
 *
 * `checkoutReconcilerSweep` runs every 10 minutes. It lists the last 48 hours
 * of completed Stripe Checkout Sessions (read-only), finds paid ones older
 * than 5 minutes with no purchase, logs `checkout.reconcile.stranded` to
 * Axiom, alerts the Slack ops channel, and requests one fulfillment per
 * session.
 *
 * `checkoutReconcileFulfill` runs the registered
 * `stripe-checkout-session-completed` handler directly for one session, under
 * its own idempotency key (`checkout-reconcile:<session id>`), with the
 * guards in `fulfillCheckoutSessionDirectly`.
 *
 * Kill switch: `AIH_CHECKOUT_RECONCILER_AUTO_FULFILL_DISABLED=true` keeps the
 * sweep and its alerts and stops every fulfillment. Default: auto-fulfill on.
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
	findFulfilledCheckoutSessionIds,
	inspectCheckoutFulfillment,
} from '@/lib/checkout-reconcile/inspect'
import {
	checkoutAutoFulfillEnabled,
	CHECKOUT_RECONCILE_KILL_SWITCH_ENV,
	summarizeCheckoutSession,
} from '@/lib/checkout-reconcile/policy'
import {
	runCheckoutReconcileSweep,
	type StrandedCheckout,
} from '@/lib/checkout-reconcile/sweep'
import { log } from '@/server/logger'
import type { StripePaymentAdapter } from '@coursebuilder/commerce/stripe-provider'
import { courseBuilderCoreFunctions } from '@coursebuilder/server'

const MAX_LISTED_SESSIONS = 10_000

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
			error: error instanceof Error ? error.message : String(error),
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
						// Carries `latest_charge` as an id, for the indexed lookup.
						expand: ['data.payment_intent'],
					})
					.autoPagingToArray({ limit: MAX_LISTED_SESSIONS })
				return sessions.map(summarizeCheckoutSession)
			},
			findFulfilled: async (sessions) => [
				...(await findFulfilledCheckoutSessionIds(db, sessions)),
			],
			getCheckoutSession: (id) =>
				paymentsAdapter(paymentProvider).getCheckoutSession(id),
			log: writeLog,
			alert: async ({ stranded, held, autoFulfill }) => {
				const lines = [
					...stranded.map(describeStranded),
					...held.map(
						(item) => `${describeStranded(item)} (held: ${item.reason})`,
					),
				]
				const overdue = stranded.some((item) => item.overdue)
				const action = autoFulfill
					? overdue
						? 'Auto-fulfill was requested and has not landed. Run `pnpm checkout:recover --checkout-session-id <id> --direct --apply`.'
						: 'Auto-fulfill requested through the same checkout handler.'
					: `Auto-fulfill is OFF (${CHECKOUT_RECONCILE_KILL_SWITCH_ENV}). Run \`pnpm checkout:recover --checkout-session-id <id> --direct --apply\`.`
				await sendOpsAlert({
					title: `Paid checkout with no purchase: ${stranded.length + held.length}`,
					text: `${lines.join('\n')}\n${action}${held.length ? '\nHeld sessions need a human: disputed, or the charge could not be read.' : ''}`,
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
		// the dropped original event consumed cannot block this run.
		idempotency: 'event.data.reconcileKey',
		retries: 3,
		concurrency: { key: 'event.data.checkoutSessionId', limit: 1 },
		onFailure: async ({ event, error }) => {
			const checkoutSessionId = event.data.event.data.checkoutSessionId
			await log.error('checkout.reconcile.fulfill_failed', {
				checkoutSessionId,
				error: error.message,
			})
			await sendOpsAlert({
				title: 'Checkout reconciler could not fulfill a paid checkout',
				text: `\`${checkoutSessionId}\`: ${error.message}\nRun \`pnpm checkout:recover --checkout-session-id ${checkoutSessionId} --direct\` for a dry run first.`,
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
			inspect: (input) => inspectCheckoutFulfillment(db, input),
			appName: env.NEXT_PUBLIC_APP_NAME,
			now: () => new Date(),
			txnId: `aih-checkout-reconcile-${checkoutSessionId}`,
		})

		await step.run('record reconcile outcome', async () => {
			const level = result.status === 'skipped' ? 'warn' : 'info'
			await log[level](`checkout.reconcile.${result.status}`, { ...result })
			if (result.status === 'fulfilled') {
				await sendOpsAlert({
					title: 'Checkout reconciler fulfilled a stranded checkout',
					text: `\`${checkoutSessionId}\` → purchase \`${result.purchaseId}\``,
					color: '#12b76a',
				})
			}
			return null
		})
		return result
	},
)
