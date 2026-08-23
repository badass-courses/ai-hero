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
 * This module rebuilds only the three capabilities the recovery command needs,
 * reading exactly the variables it uses. The Next app keeps its own singletons
 * unchanged.
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

import type {
	CheckoutRecoveryRuntime,
	CheckoutRecoveryState,
} from './checkout-recovery'

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

	return {
		databaseUrl: present(source, 'DATABASE_URL') as string,
		stripeToken: present(source, 'STRIPE_SECRET_TOKEN') as string,
		stripeWebhookSecret: present(source, 'STRIPE_WEBHOOK_SECRET') ?? '',
		inngestAppId: options.apply
			? (present(source, 'NEXT_PUBLIC_APP_NAME') as string)
			: null,
	}
}

/**
 * Builds the live runtime: Stripe reads, database reads, and — in apply mode
 * only — one Inngest replay send.
 */
export async function createCheckoutRecoveryRuntime(
	env: CheckoutRecoveryEnv,
): Promise<CheckoutRecoveryRuntime> {
	const [
		{ StripePaymentAdapter },
		schema,
		{ preserveQueryResultShape },
		{ createDatabasePoolCloser },
		drizzleOrm,
		{ drizzle },
		mysqlModule,
	] = await Promise.all([
		import('@coursebuilder/core/providers/stripe'),
		import('@/db/schema'),
		import('@/db/mysql-query-client'),
		import('@/db/pool-lifecycle'),
		import('drizzle-orm'),
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

	const paymentsAdapter = new StripePaymentAdapter({
		stripeToken: env.stripeToken,
		stripeWebhookSecret: env.stripeWebhookSecret,
	})

	return {
		getCheckoutSession: (checkoutSessionId) =>
			paymentsAdapter.getCheckoutSession(checkoutSessionId),
		inspect: async ({
			checkoutSessionId,
			chargeId,
		}): Promise<CheckoutRecoveryState> => {
			const chargeRows = await db
				.select({ id: schema.merchantCharge.id })
				.from(schema.merchantCharge)
				.where(drizzleOrm.eq(schema.merchantCharge.identifier, chargeId))
			const sessionRows = await db
				.select({ id: schema.merchantSession.id })
				.from(schema.merchantSession)
				.where(
					drizzleOrm.eq(schema.merchantSession.identifier, checkoutSessionId),
				)
			const purchaseConditions = [
				...chargeRows.map((row) =>
					drizzleOrm.eq(schema.purchases.merchantChargeId, row.id),
				),
				...sessionRows.map((row) =>
					drizzleOrm.eq(schema.purchases.merchantSessionId, row.id),
				),
			]
			const purchaseRows = purchaseConditions.length
				? await db
						.select({ id: schema.purchases.id })
						.from(schema.purchases)
						.where(drizzleOrm.or(...purchaseConditions))
				: []
			return {
				chargeIds: chargeRows.map((row) => row.id),
				merchantSessionIds: sessionRows.map((row) => row.id),
				purchaseIds: [...new Set(purchaseRows.map((row) => row.id))],
			}
		},
		sendReplay: async (event) => {
			if (!env.inngestAppId) {
				throw new Error('Replay send requires apply mode environment')
			}
			const { Inngest } = await import('inngest')
			const client = new Inngest({ id: env.inngestAppId })
			return client.send(event)
		},
		close: closePool,
	}
}
