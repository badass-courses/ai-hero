import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
	coupon,
	contentResource,
	contentResourceProduct,
	contentResourceResource,
	merchantAccount,
	merchantCharge,
	merchantCoupon,
	merchantCustomer,
	merchantPrice,
	merchantProduct,
	merchantSession,
	prices,
	products,
	purchases,
	purchaseUserTransfer,
	roles,
	upgradableProducts,
	userRoles,
	users,
} from '@/db/schema'
import * as schema from '@/db/schema'
import { mysqlTable } from '@/db/mysql-table'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { validateMySqlIntegrationServerUrl } from '@/lib/team-purchase-mysql-test-guard'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'
import type Stripe from 'stripe'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'
import { courseBuilderCoreFunctions } from '@coursebuilder/server'

import {
	findCheckoutHandler,
	fulfillCheckoutSessionDirectly,
	type CheckoutFulfillDatabase,
	type CheckoutFulfillStep,
} from './fulfill'
import { findFulfilledCheckoutSessionIds, inspectCheckoutFulfillment } from './inspect'

// Real Course Builder checkout handler, real Drizzle adapter, disposable
// MySQL with tables generated from the app schema. Stripe is a fixture: the
// session the handler reads is the expanded shape `getCheckoutSession`
// returns. No Stripe, Inngest or production database is touched.
const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL

// drizzle-kit's ESM build cannot load under Vite; its CommonJS build can.
const { generateMySQLDrizzleJson, generateMySQLMigration } = createRequire(
	import.meta.url,
)('drizzle-kit/api') as typeof import('drizzle-kit/api')
const integration = describe.skipIf(!serverUrl)

const now = new Date('2026-10-09T22:00:00Z')
const APP = 'ai-hero'
const BUYER_ID = 'user_reconcile_buyer'
const STRIPE_CUSTOMER = 'cus_reconcile'

const tables = {
	users,
	roles,
	userRoles,
	merchantAccount,
	merchantProduct,
	merchantCustomer,
	merchantCharge,
	merchantSession,
	merchantCoupon,
	merchantPrice,
	coupon,
	purchases,
	purchaseUserTransfer,
	products,
	prices,
	contentResource,
	contentResourceProduct,
	contentResourceResource,
	upgradableProducts,
}

type Charge = { refunded?: boolean; amount_refunded?: number; disputed?: boolean }

function checkoutSession(
	id: string,
	overrides: Partial<Stripe.Checkout.Session> = {},
	charge: Charge = {},
): Stripe.Checkout.Session {
	const chargeId = `ch_${id.slice(3)}`
	return {
		id,
		object: 'checkout.session',
		amount_subtotal: 29_900,
		amount_total: 29_900,
		created: Math.floor(now.getTime() / 1000) - 12 * 60,
		currency: 'usd',
		custom_fields: [],
		customer: {
			id: STRIPE_CUSTOMER,
			email: 'buyer@example.test',
			name: 'Fixture Buyer',
		},
		customer_details: {
			address: {
				city: 'Portland',
				country: 'US',
				line1: null,
				line2: null,
				postal_code: '97201',
				state: 'OR',
			},
			email: 'buyer@example.test',
			name: 'Fixture Buyer',
		},
		line_items: {
			data: [
				{
					quantity: 1,
					discounts: [],
					price: {
						id: 'price_reconcile',
						product: { id: 'prod_reconcile', name: 'Crash Course' },
					},
				},
			],
		},
		livemode: false,
		metadata: {
			siteName: APP,
			productId: 'product_reconcile',
			product: 'Crash Course',
			userId: BUYER_ID,
			bulk: 'false',
			country: 'US',
			ip_address: '',
		},
		mode: 'payment',
		payment_intent: {
			id: `pi_${id.slice(3)}`,
			amount_received: 29_900,
			latest_charge: {
				id: chargeId,
				amount: 29_900,
				refunded: false,
				amount_refunded: 0,
				disputed: false,
				...charge,
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

/** An Inngest-like step: runs each step once and returns JSON, like Inngest. */
function inngestLikeStep(options: { beforeStep?: (id: string) => Promise<void> } = {}) {
	const sent: { id: string; payload: any }[] = []
	const ran: string[] = []
	const step: CheckoutFulfillStep = {
		run: async (id, fn) => {
			await options.beforeStep?.(id)
			ran.push(id)
			const output = await fn()
			return output === undefined ? undefined : JSON.parse(JSON.stringify(output))
		},
		sendEvent: async (id, payload) => {
			sent.push({ id, payload })
			return { ids: [`evt_${sent.length}`] }
		},
	}
	return { step, sent, ran }
}

/** Holds every arrival until `parties` callers reach it. */
function barrier(parties: number) {
	let arrived = 0
	let release!: () => void
	const open = new Promise<void>((resolve) => (release = resolve))
	return async () => {
		arrived += 1
		if (arrived >= parties) release()
		await open
	}
}

interface CountRow extends RowDataPacket {
	charges: number
	sessions: number
	purchases: number
}

integration('checkout reconciler direct fulfillment on disposable MySQL', () => {
	let server: Pool | undefined
	let pool: Pool
	let name: string | undefined
	let database: MySqlDatabase<any, any, typeof schema>
	let adapter: CheckoutFulfillDatabase
	const handler = findCheckoutHandler(courseBuilderCoreFunctions)
	const sessions = new Map<string, Stripe.Checkout.Session>()

	const paymentProvider = {
		id: 'stripe',
		name: 'Stripe',
		type: 'payment',
		options: {
			paymentsAdapter: {
				getCheckoutSession: async (id: string) => {
					const session = sessions.get(id)
					if (!session) throw new Error(`No fixture for ${id}`)
					return structuredClone(session)
				},
			},
		},
	}

	const inspect = (input: { checkoutSessionId: string; chargeId: string | null }) =>
		inspectCheckoutFulfillment(database, input)

	function reconcile(checkoutSessionId: string, step: CheckoutFulfillStep) {
		return fulfillCheckoutSessionDirectly(checkoutSessionId, {
			handler,
			step,
			db: adapter,
			paymentProvider,
			getCheckoutSession: paymentProvider.options.paymentsAdapter.getCheckoutSession,
			inspect,
			appName: APP,
			now: () => now,
			txnId: `aih-checkout-reconcile-${checkoutSessionId}`,
		})
	}

	/** The original webhook-driven run: the same handler, no reconciler guard. */
	function originalRun(checkoutSessionId: string, step: CheckoutFulfillStep) {
		const session = sessions.get(checkoutSessionId)!
		return handler({
			event: {
				name: 'stripe/checkout-session-completed',
				data: {
					txnId: `original-${checkoutSessionId}`,
					stripeEvent: {
						id: `evt_original_${checkoutSessionId}`,
						created: session.created,
						type: 'checkout.session.completed',
						data: {
							object: {
								...session,
								customer: STRIPE_CUSTOMER,
								payment_intent: (session.payment_intent as { id: string }).id,
							},
						},
					},
				},
			},
			step,
			db: adapter,
			paymentProvider,
		}) as Promise<{ purchase: { id: string } }>
	}

	async function counts(checkoutSessionId: string) {
		const chargeId = `ch_${checkoutSessionId.slice(3)}`
		const [[row]] = await pool.query<CountRow[]>(
			`SELECT
				(SELECT COUNT(*) FROM AI_MerchantCharge WHERE identifier = ?) AS charges,
				(SELECT COUNT(*) FROM AI_MerchantSession WHERE identifier = ?) AS sessions,
				(SELECT COUNT(*) FROM AI_Purchase p
					JOIN AI_MerchantCharge c ON c.id = p.merchantChargeId
					WHERE c.identifier = ?) AS purchases`,
			[chargeId, checkoutSessionId, chargeId],
		)
		return {
			charges: Number(row!.charges),
			sessions: Number(row!.sessions),
			purchases: Number(row!.purchases),
		}
	}

	function stranded(overrides: Partial<Stripe.Checkout.Session> = {}, charge: Charge = {}) {
		const id = `cs_test_${randomUUID().replaceAll('-', '')}`
		sessions.set(id, checkoutSession(id, overrides, charge))
		return id
	}

	beforeAll(async () => {
		const safe = validateMySqlIntegrationServerUrl(serverUrl!, {
			nodeEnv: process.env.NODE_ENV,
			vercelEnv: process.env.VERCEL_ENV,
		})
		server = mysql.createPool({ uri: safe.toString(), timezone: 'Z' })
		name = `aih_checkout_reconcile_${randomUUID().replaceAll('-', '')}`
		await server.query(
			`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
		)
		const target = new URL(safe)
		target.pathname = `/${name}`
		pool = preserveQueryResultShape(
			mysql.createPool({ uri: target.toString(), timezone: 'Z', connectionLimit: 8 }),
		)
		const acquire = pool.getConnection.bind(pool)
		pool.getConnection = (async () =>
			preserveQueryResultShape(await acquire())) as typeof pool.getConnection

		// Tables and keys straight from the app schema, so the unique
		// MerchantCharge.identifier this relies on is the one production has.
		const statements = await generateMySQLMigration(
			await generateMySQLDrizzleJson({}),
			await generateMySQLDrizzleJson(tables),
		)
		for (const statement of statements) await pool.query(statement)

		database = drizzle(pool, { schema, mode: 'planetscale' }) as unknown as MySqlDatabase<any, any, typeof schema>
		adapter = DrizzleAdapter<MySqlDatabase<any, any, typeof schema>>(
			database,
			mysqlTable,
		) as unknown as CheckoutFulfillDatabase
		// Generating the schema and loading the Course Builder server bundle
		// runs past vitest's 10s hook default on a cold start.
	}, 60_000)

	afterAll(async () => {
		await pool?.end()
		if (server && name) await server.query(`DROP DATABASE \`${name}\``)
		await server?.end()
	})

	beforeEach(async () => {
		for (const table of [
			'AI_PurchaseUserTransfer',
			'AI_Purchase',
			'AI_MerchantSession',
			'AI_MerchantCharge',
			'AI_MerchantCustomer',
			'AI_MerchantProduct',
			'AI_MerchantAccount',
			'AI_Product',
			'AI_User',
		])
			await pool.query(`DELETE FROM ${table}`)
		await pool.query(
			"INSERT INTO AI_User (id, email, name) VALUES (?, 'buyer@example.test', 'Fixture Buyer')",
			[BUYER_ID],
		)
		await pool.query(
			"INSERT INTO AI_MerchantAccount (id, status, label, identifier) VALUES ('ma_reconcile', 1, 'stripe', 'acct_reconcile')",
		)
		await pool.query(
			"INSERT INTO AI_Product (id, name, type, status, fields) VALUES ('product_reconcile', 'Crash Course', 'self-paced', 1, JSON_OBJECT('slug', 'crash-course'))",
		)
		await pool.query(
			"INSERT INTO AI_MerchantProduct (id, merchantAccountId, productId, status, identifier) VALUES ('mp_reconcile', 'ma_reconcile', 'product_reconcile', 1, 'prod_reconcile')",
		)
		// A returning Stripe customer, so concurrent runs meet at the purchase
		// write rather than at customer creation.
		await pool.query(
			'INSERT INTO AI_MerchantCustomer (id, userId, merchantAccountId, identifier) VALUES (?, ?, ?, ?)',
			['mcu_reconcile', BUYER_ID, 'ma_reconcile', STRIPE_CUSTOMER],
		)
	})

	it('fulfills a stranded session exactly once', async () => {
		const id = stranded()
		const first = inngestLikeStep()
		const result = await reconcile(id, first.step)

		expect(result).toMatchObject({ status: 'fulfilled', checkoutSessionId: id })
		expect(await counts(id)).toEqual({ charges: 1, sessions: 1, purchases: 1 })
		expect(first.sent.map((event) => event.payload.name)).toEqual([
			'commerce/new-purchase-created',
		])
		expect(first.sent[0]!.payload.data).toMatchObject({
			purchaseId: (result as { purchaseId: string }).purchaseId,
			checkoutSessionId: id,
			txnId: `aih-checkout-reconcile-${id}`,
		})

		// A second sweep finds it fulfilled; the reconciler does nothing.
		expect(
			await findFulfilledCheckoutSessionIds(database, [
				{ checkoutSessionId: id, chargeId: `ch_${id.slice(3)}` },
			]),
		).toEqual(new Set([id]))
		const second = inngestLikeStep()
		expect(await reconcile(id, second.step)).toMatchObject({
			status: 'already_fulfilled',
			purchaseIds: [(result as { purchaseId: string }).purchaseId],
		})
		expect(second.sent).toEqual([])
		expect(second.ran).not.toContain('load the merchant account')
		expect(await counts(id)).toEqual({ charges: 1, sessions: 1, purchases: 1 })
	})

	it('leaves an already-fulfilled session untouched', async () => {
		const id = stranded()
		const original = await originalRun(id, inngestLikeStep().step)
		const before = await counts(id)

		const run = inngestLikeStep()
		const result = await reconcile(id, run.step)

		expect(result).toMatchObject({
			status: 'already_fulfilled',
			purchaseIds: [original.purchase.id],
		})
		expect(run.sent).toEqual([])
		expect(run.ran).toEqual([
			'reconcile: load checkout session',
			'reconcile: re-check fulfillment',
		])
		expect(await counts(id)).toEqual(before)
		expect(before).toEqual({ charges: 1, sessions: 1, purchases: 1 })
	})

	it('gives one purchase when the original run races the reconciler', async () => {
		for (let round = 0; round < 5; round += 1) {
			const id = stranded()
			// Both runs pass every read, then hit the purchase write together.
			const meet = barrier(2)
			const atWrite = async (stepId: string) => {
				if (stepId === 'create a merchant charge and purchase') await meet()
			}
			const reconciler = inngestLikeStep({ beforeStep: atWrite })
			const original = inngestLikeStep({ beforeStep: atWrite })

			const [reconciled, originalOutcome] = await Promise.allSettled([
				reconcile(id, reconciler.step),
				originalRun(id, original.step),
			])

			expect(await counts(id)).toEqual({ charges: 1, sessions: 1, purchases: 1 })
			expect(reconciled.status).toBe('fulfilled')
			const outcome = (reconciled as PromiseFulfilledResult<any>).value
			expect(['fulfilled', 'raced']).toContain(outcome.status)
			const purchaseId =
				outcome.status === 'fulfilled' ? outcome.purchaseId : outcome.purchaseIds[0]
			if (originalOutcome.status === 'fulfilled') {
				// The loser adopted the winner's purchase instead of making one.
				expect(originalOutcome.value.purchase.id).toBe(purchaseId)
			}
			// The reconciler announces a purchase only when it made it.
			expect(reconciler.sent.length).toBe(outcome.status === 'fulfilled' ? 1 : 0)
		}
	})

	it('stands down when the original run commits between its re-check and its write', async () => {
		const id = stranded()
		let original: { purchase: { id: string } } | undefined
		const reconciler = inngestLikeStep({
			beforeStep: async (stepId) => {
				if (stepId === 'create a merchant charge and purchase')
					original = await originalRun(id, inngestLikeStep().step)
			},
		})

		const result = await reconcile(id, reconciler.step)

		expect(result).toMatchObject({
			status: 'raced',
			purchaseIds: [original!.purchase.id],
		})
		// The guard tripped inside the write step, before the handler could
		// announce a purchase it did not make.
		expect(reconciler.sent).toEqual([])
		expect(await counts(id)).toEqual({ charges: 1, sessions: 1, purchases: 1 })
	})

	it('keeps one purchase when two adapter writes for one charge collide', async () => {
		// The last layer: the adapter's locking read and the unique
		// MerchantCharge.identifier, with no reconciler guard in front.
		for (let round = 0; round < 10; round += 1) {
			const id = stranded()
			const options = {
				userId: BUYER_ID,
				productId: 'product_reconcile',
				stripeChargeId: `ch_${id.slice(3)}`,
				merchantAccountId: 'ma_reconcile',
				merchantProductId: 'mp_reconcile',
				merchantCustomerId: 'mcu_reconcile',
				stripeChargeAmount: 29_900,
				quantity: 1,
				checkoutSessionId: id,
			}
			const outcomes = await Promise.allSettled([
				adapter.createMerchantChargeAndPurchase(options),
				adapter.createMerchantChargeAndPurchase(options),
			])

			expect(await counts(id)).toEqual({ charges: 1, sessions: 1, purchases: 1 })
			const ids = outcomes
				.filter((o) => o.status === 'fulfilled')
				.map((o) => (o as PromiseFulfilledResult<{ id: string }>).value.id)
			expect(new Set(ids).size).toBe(1)
			for (const outcome of outcomes) {
				if (outcome.status === 'rejected')
					expect(String(outcome.reason)).toMatch(/Deadlock|Duplicate entry/)
			}
		}
	})

	it('gives one purchase when the original run arrives after the reconciler', async () => {
		const id = stranded()
		const reconciled = await reconcile(id, inngestLikeStep().step)
		const late = await originalRun(id, inngestLikeStep().step)

		expect(reconciled.status).toBe('fulfilled')
		expect(late.purchase.id).toBe((reconciled as { purchaseId: string }).purchaseId)
		expect(await counts(id)).toEqual({ charges: 1, sessions: 1, purchases: 1 })
	})

	it('ignores unpaid and expired sessions without writing', async () => {
		const unpaid = stranded({ payment_status: 'unpaid' })
		const expired = stranded({ status: 'expired', payment_status: 'unpaid' })

		for (const [id, reason] of [
			[unpaid, 'not_paid'],
			[expired, 'not_complete'],
		] as const) {
			const run = inngestLikeStep()
			expect(await reconcile(id, run.step)).toMatchObject({
				status: 'skipped',
				reason,
			})
			expect(run.sent).toEqual([])
			expect(await counts(id)).toEqual({ charges: 0, sessions: 0, purchases: 0 })
		}
	})

	it('ignores a refunded session without writing', async () => {
		const id = stranded({}, { refunded: true, amount_refunded: 29_900 })
		const run = inngestLikeStep()

		expect(await reconcile(id, run.step)).toMatchObject({
			status: 'skipped',
			reason: 'refunded',
		})
		expect(run.sent).toEqual([])
		expect(await counts(id)).toEqual({ charges: 0, sessions: 0, purchases: 0 })
	})
})
