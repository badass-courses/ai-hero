/**
 * Script-safe runtime for the `checkout:recover` operator command.
 *
 * The Next app's own singletons cannot be loaded by a bare Node process:
 *
 *   - `@/db` and `@/coursebuilder/stripe-provider` import `@/env.mjs`, which
 *     validates the whole Next environment. A recovery run would otherwise need
 *     ~27 unrelated variables (Mux, Deepgram, Postmark, ConvertKit, Cloudinary,
 *     every `NEXT_PUBLIC_*`) before it could read one Stripe session.
 *   - `@/inngest/inngest.server` reaches `@/server/organization-context`, which
 *     imports `server-only`. That specifier only resolves inside Next's
 *     bundler, so the import throws `ERR_MODULE_NOT_FOUND` under `tsx`.
 *
 * This module rebuilds only the capabilities the recovery command needs,
 * reading exactly the variables it uses. The Next app keeps its own singletons
 * unchanged. The one exception is direct fulfillment (`--direct`, or a replay
 * that produced no run): it runs the app's own checkout handler with the app's
 * own identity, Stripe and Slack providers, so it loads those modules lazily
 * and needs the full app environment and `--conditions=react-server`.
 *
 * Stripe reads go through the same `StripePaymentAdapter` the app uses, so the
 * session expansion the recovery logic depends on cannot drift.
 *
 * The Inngest client here is a plain client rather than the app's. Neither
 * middleware on the app client hooks event sending: the Course Builder
 * middleware registers no `onSendEvent`, and `inngestTelemetryMiddleware`
 * registers only `onFunctionRun`. The app id is read from
 * `NEXT_PUBLIC_APP_NAME` rather than guessed, so the event source matches.
 *
 * @module checkout-recovery-runtime
 */

import type { CheckoutRecoveryRuntime } from './checkout-recovery'

export type CheckoutRecoveryEnvSource = Record<string, string | undefined>

export type CheckoutRecoveryEnv = {
	databaseUrl: string
	stripeToken: string
	/**
	 * Unused by the recovery read path. `StripePaymentAdapter` takes it for
	 * webhook verification, which this command never performs.
	 */
	stripeWebhookSecret: string
	/** Only present when the command runs in apply mode. */
	inngestAppId: string | null
	/**
	 * `NEXT_PUBLIC_APP_NAME` when set, in any mode. `--direct` needs it to
	 * check the session's `siteName` before predicting a fulfillment.
	 */
	appName: string | null
	/** Optional. Lets an apply run confirm the replay produced a run. */
	inngestSigningKey: string | null
}

/** Variables the command needs in every mode. */
export const CHECKOUT_RECOVERY_REQUIRED_ENV = [
	'DATABASE_URL',
	'STRIPE_SECRET_TOKEN',
] as const

/** Variables the command additionally needs before it may send a replay. */
export const CHECKOUT_RECOVERY_APPLY_ENV = [
	'INNGEST_EVENT_KEY',
	'NEXT_PUBLIC_APP_NAME',
] as const

function present(
	source: CheckoutRecoveryEnvSource,
	name: string,
): string | null {
	const value = source[name]
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : null
}

/**
 * `vercel env pull` writes this literal for every sensitive variable. A file
 * that carries it has no usable secret, so fail before any Stripe or Inngest
 * round trip instead of with a 401 at send time.
 */
export const VERCEL_SENSITIVE_PLACEHOLDER = '[SENSITIVE]'

/**
 * Resolves the environment the recovery command genuinely uses.
 *
 * Reports missing variable NAMES only. It never echoes a value.
 */
export function resolveCheckoutRecoveryEnv(
	source: CheckoutRecoveryEnvSource,
	options: { apply: boolean },
): CheckoutRecoveryEnv {
	const names = [
		...CHECKOUT_RECOVERY_REQUIRED_ENV,
		...(options.apply ? CHECKOUT_RECOVERY_APPLY_ENV : []),
	]
	const missing = names.filter((name) => present(source, name) === null)
	if (missing.length > 0) {
		throw new Error(
			`Missing required environment variables: ${missing.join(', ')}`,
		)
	}
	const placeholders = names.filter(
		(name) => present(source, name) === VERCEL_SENSITIVE_PLACEHOLDER,
	)
	if (placeholders.length > 0) {
		throw new Error(
			`Environment variables hold the Vercel "[SENSITIVE]" placeholder, not a value: ${placeholders.join(', ')}. Lease the real value (for example \`secrets lease ai-hero::inngest_event_key\`) and export it.`,
		)
	}

	return {
		databaseUrl: present(source, 'DATABASE_URL') as string,
		stripeToken: present(source, 'STRIPE_SECRET_TOKEN') as string,
		stripeWebhookSecret: present(source, 'STRIPE_WEBHOOK_SECRET') ?? '',
		inngestAppId: options.apply
			? (present(source, 'NEXT_PUBLIC_APP_NAME') as string)
			: null,
		appName: present(source, 'NEXT_PUBLIC_APP_NAME'),
		inngestSigningKey: options.apply
			? present(source, 'INNGEST_SIGNING_KEY')
			: null,
	}
}

const REPLAY_RUN_POLL_INTERVAL_MS = 5_000
const REPLAY_RUN_POLL_ATTEMPTS = 12

/**
 * Asks the Inngest REST API how many runs each sent event created, for up to
 * a minute. Returns null when there is no signing key to ask with.
 */
export async function countInngestEventRuns(
	eventIds: string[],
	signingKey: string | null,
	options: {
		fetch?: typeof fetch
		intervalMs?: number
		attempts?: number
	} = {},
): Promise<number | null> {
	if (!signingKey) return null
	const fetcher = options.fetch ?? fetch
	const intervalMs = options.intervalMs ?? REPLAY_RUN_POLL_INTERVAL_MS
	const attempts = options.attempts ?? REPLAY_RUN_POLL_ATTEMPTS
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (attempt > 0) await new Promise((r) => setTimeout(r, intervalMs))
		let runs = 0
		for (const eventId of eventIds) {
			const response = await fetcher(
				`https://api.inngest.com/v1/events/${encodeURIComponent(eventId)}/runs`,
				{ headers: { Authorization: `Bearer ${signingKey}` } },
			)
			if (!response.ok) {
				throw new Error(`Inngest runs lookup failed with ${response.status}`)
			}
			const body = (await response.json()) as { data?: unknown[] }
			runs += body.data?.length ?? 0
		}
		if (runs > 0) return runs
	}
	return 0
}

/**
 * Builds the live runtime: Stripe reads, database reads, and, in apply mode
 * only, one Inngest replay send or one direct handler run.
 */
export async function createCheckoutRecoveryRuntime(
	env: CheckoutRecoveryEnv,
): Promise<CheckoutRecoveryRuntime> {
	const [
		{ StripePaymentAdapter },
		schema,
		{ preserveQueryResultShape },
		{ createDatabasePoolCloser },
		{ inspectCheckoutFulfillment, findBuyerProductPurchaseIds },
		{ drizzle },
		mysqlModule,
	] = await Promise.all([
		import('@coursebuilder/commerce/stripe-provider'),
		import('@/db/schema'),
		import('@/db/mysql-query-client'),
		import('@/db/pool-lifecycle'),
		import('@/lib/checkout-reconcile/inspect'),
		import('drizzle-orm/mysql2'),
		import('mysql2/promise'),
	])

	const mysql = mysqlModule.default
	const pool = preserveQueryResultShape(
		mysql.createPool({
			uri: env.databaseUrl,
			connectionLimit: 2,
			maxIdle: 2,
			timezone: 'Z',
			enableKeepAlive: true,
		}),
	)
	const db = drizzle(pool, { schema, mode: 'planetscale' })
	const closePool = createDatabasePoolCloser(pool)
	// Set once direct fulfillment loads the app's own `@/db` pool.
	let closeAppPool: (() => Promise<void>) | null = null

	const paymentsAdapter = new StripePaymentAdapter({
		stripeToken: env.stripeToken,
		stripeWebhookSecret: env.stripeWebhookSecret,
	})

	return {
		appName: env.appName,
		getCheckoutSession: (checkoutSessionId) =>
			paymentsAdapter.getCheckoutSession(checkoutSessionId),
		inspect: (input) => inspectCheckoutFulfillment(db, input),
		sendReplay: async (event) => {
			if (!env.inngestAppId) {
				throw new Error('Replay send requires apply mode environment')
			}
			const { Inngest } = await import('inngest')
			// Explicit cloud mode. Without `isDev: false` the SDK infers dev mode
			// from a shell with no NODE_ENV and, if a local dev server answers on
			// :8288, posts the replay there while reporting success.
			const client = new Inngest({ id: env.inngestAppId, isDev: false })
			return client.send(event)
		},
		countReplayRuns: (eventIds) =>
			countInngestEventRuns(eventIds, env.inngestSigningKey),
		fulfillDirect: async (checkoutSessionId) => {
			if (!env.inngestAppId) {
				throw new Error('Direct fulfillment requires apply mode environment')
			}
			// The app's own handler, identity and providers. These modules
			// validate the full app environment on import.
			const [
				{ courseBuilderCoreFunctions },
				{ magicLinkIdentity },
				{ stripeProvider },
				{ slackProvider },
				{ fulfillCheckoutSessionDirectly, findCheckoutHandler },
				{ closeDatabasePool },
				{ Inngest },
				{ AUTHORITATIVE_PRODUCT_IDS },
			] = await Promise.all([
				import('@coursebuilder/server'),
				import('@/coursebuilder/email-provider'),
				import('@/coursebuilder/stripe-provider'),
				import('@/coursebuilder/slack-provider'),
				import('@/lib/checkout-reconcile/fulfill'),
				import('@/db'),
				import('inngest'),
				import('@/lib/c5-pricing/decision'),
			])
			closeAppPool = closeDatabasePool
			const client = new Inngest({ id: env.inngestAppId, isDev: false })
			const appPaymentsAdapter = stripeProvider.options
				.paymentsAdapter as InstanceType<typeof StripePaymentAdapter>
			return fulfillCheckoutSessionDirectly(checkoutSessionId, {
				handler: findCheckoutHandler(courseBuilderCoreFunctions),
				step: {
					run: async (_name, fn) => {
						const output = await fn()
						// Match Inngest, which hands step output back as JSON.
						return output === undefined
							? undefined
							: JSON.parse(JSON.stringify(output))
					},
					sendEvent: (_name, payload) => client.send(payload),
				},
				db: magicLinkIdentity as never,
				paymentProvider: stripeProvider,
				notificationProvider: slackProvider,
				getCheckoutSession: (id) => appPaymentsAdapter.getCheckoutSession(id),
				onPaidSession: async (session) => (await import('@/lib/c5-pricing/gift-settlement')).settleGiftSession(session),
				inspect: (input) => inspectCheckoutFulfillment(db, input),
				// C5 duplicates are fulfilled and flagged after payment, never held.
				holdsWhenBuyerHasProduct: (productId) =>
					!AUTHORITATIVE_PRODUCT_IDS.has(productId),
				findBuyerProductPurchases: (input) =>
					findBuyerProductPurchaseIds(db, input),
				appName: env.inngestAppId,
				now: () => new Date(),
				txnId: `aih-checkout-recover-direct-${checkoutSessionId}`,
				// An operator names one exact session; age gates do not apply.
				minAgeMs: 0,
				windowMs: Number.POSITIVE_INFINITY,
			})
		},
		close: async () => {
			await closeAppPool?.()
			await closePool()
		},
	}
}
