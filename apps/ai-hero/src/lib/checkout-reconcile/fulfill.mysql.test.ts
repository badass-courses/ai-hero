import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { persistPurchaseGeoWrite } from '@/lib/admin-sales-globe-stripe-geo'
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
	purchaseDecision,
	purchaseUserTransfer,
	roles,
	upgradableProducts,
	userRoles,
	users,
} from '@/db/schema'
import * as schema from '@/db/schema'
import { mysqlTable } from '@/db/mysql-table'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import type { DbExecutor } from '@/db'
import { checkC5Duplicate, recordC5PurchaseDecision } from '@/lib/c5-pricing/purchase-decision'
import { C5_PRODUCT_ID, encodeDecisionRef } from '@/lib/c5-pricing/decision'
import { settleGiftSession } from '@/lib/c5-pricing/gift-settlement'
import { c5DecisionStoreOn } from '@/lib/c5-pricing/purchase-decision-sql'
import { validateMySqlIntegrationServerUrl } from '@/lib/team-purchase-mysql-test-guard'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'
import type Stripe from 'stripe'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

let database: MySqlDatabase<any, any, typeof schema>
let giftSettlementPool: Pool
vi.mock('@/db', () => ({ get db() { return database }, acquireDatabaseConnection: () => giftSettlementPool.getConnection() }))

import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'
import { courseBuilderCoreFunctions } from '@coursebuilder/server'

import {
	findCheckoutHandler,
	fulfillCheckoutSessionDirectly,
	type CheckoutFulfillDatabase,
	type CheckoutFulfillStep,
} from './fulfill'
import {
	findBuyerProductPurchaseIds,
	findFulfilledCheckoutSessionIds,
	inspectCheckoutFulfillment,
} from './inspect'

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
	giftCodeSlot: schema.giftCodeSlot,
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
	purchaseDecision,
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

/** Only retry MySQL's explicit transient transaction failures, including wrapped causes. */
function transientMysqlFailure(error: unknown) {
	let current = error
	for (let depth = 0; depth < 4; depth += 1) {
		if (typeof current !== 'object' || current === null) return false
		if ('code' in current && ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(String(current.code))) return true
		current = 'cause' in current ? current.cause : undefined
	}
	return false
}

/** run -> transient DB failure -> bounded retry -> JSON result/exhaustion, like Inngest. */
function inngestLikeStep(options: { beforeStep?: (id: string) => Promise<void>; retryTransientDbErrors?: boolean } = {}) {
	const sent: { id: string; payload: any }[] = []
	const ran: string[] = []
	const step: CheckoutFulfillStep = {
		run: async (id, fn) => {
			await options.beforeStep?.(id)
			ran.push(id)
			let remaining = options.retryTransientDbErrors ? 3 : 0
			for (;;) {
				try {
					const output = await fn()
					return output === undefined ? undefined : JSON.parse(JSON.stringify(output))
				} catch (error) {
					if (!remaining || !transientMysqlFailure(error)) throw error
					remaining -= 1
				}
			}
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

	function reconcile(
		checkoutSessionId: string,
		step: CheckoutFulfillStep,
		holdsWhenBuyerHasProduct?: (productId: string) => boolean,
	) {
		return fulfillCheckoutSessionDirectly(checkoutSessionId, {
			onPaidSession: sessions.get(checkoutSessionId)?.metadata?.codeRef ? settleGiftSession : undefined,
			holdsWhenBuyerHasProduct,
			handler,
			step,
			db: adapter,
			paymentProvider,
			getCheckoutSession: paymentProvider.options.paymentsAdapter.getCheckoutSession,
			inspect,
			findBuyerProductPurchases: (input) =>
				findBuyerProductPurchaseIds(database, input),
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
		giftSettlementPool = pool
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
		// Prove the hand-written deploy migration, including its idempotence.
		await pool.query('DROP TABLE AI_PurchaseDecision')
		const ledgerMigration = await readFile(new URL('../../db/migrations/20261010_ai_hero_purchase_decision.sql', import.meta.url), 'utf8')
		await pool.query(ledgerMigration)
		await pool.query(ledgerMigration)

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
			'AI_GiftCodeSlot',
			'AI_PurchaseDecision',
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

	it('spends a paid gift reservation on direct fulfillment and replay', async () => {
		await pool.query('UPDATE AI_Product SET id = ? WHERE id = ?', [C5_PRODUCT_ID, 'product_reconcile'])
		await pool.query('UPDATE AI_MerchantProduct SET productId = ?', [C5_PRODUCT_ID])
		const codeRef = 'synthetic-gift-code'
		const claimId = 'synthetic-gift-claim'
		const id = stranded({ metadata: { ...checkoutSession('template').metadata, productId: C5_PRODUCT_ID, codeRef, giftClaimId: claimId, decisionRef: encodeDecisionRef('0000000000000000', null, codeRef) } })
		await pool.query('INSERT INTO AI_GiftCodeSlot (codeRef, slot, checkoutSessionId, claimId, state, expiresAt) VALUES (?, 1, ?, ?, ?, ?)', [codeRef, id, claimId, 'reserved', new Date(now.getTime() + 3600000)])
		expect(await reconcile(id, inngestLikeStep().step)).toMatchObject({ status: 'fulfilled' })
		const [rows] = await pool.query<RowDataPacket[]>('SELECT state FROM AI_GiftCodeSlot WHERE checkoutSessionId = ?', [id])
		expect(rows[0]?.state).toBe('spent')
		await pool.query('UPDATE AI_GiftCodeSlot SET state = ? WHERE checkoutSessionId = ?', ['reserved', id])
		expect(await reconcile(id, inngestLikeStep().step)).toMatchObject({ status: 'already_fulfilled' })
		const [replay] = await pool.query<RowDataPacket[]>('SELECT state FROM AI_GiftCodeSlot WHERE checkoutSessionId = ?', [id])
		expect(replay[0]?.state).toBe('spent')
		expect(await counts(id)).toEqual({ charges: 1, sessions: 1, purchases: 1 })
	})

	it('fulfills a paid gift even when its reservation is missing', async () => {
		await pool.query('UPDATE AI_Product SET id = ? WHERE id = ?', [C5_PRODUCT_ID, 'product_reconcile'])
		await pool.query('UPDATE AI_MerchantProduct SET productId = ?', [C5_PRODUCT_ID])
		const codeRef = 'synthetic-missing-gift'
		const id = stranded({ metadata: { ...checkoutSession('template').metadata, productId: C5_PRODUCT_ID, codeRef, giftClaimId: 'missing', decisionRef: encodeDecisionRef('0000000000000000', null, codeRef) } })
		expect(await reconcile(id, inngestLikeStep().step)).toMatchObject({ status: 'fulfilled' })
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

	it('the step shim retries only explicit transient DB failures with a finite budget', async () => {
		const transient = Object.assign(new Error('wrapped'), { cause: { code: 'ER_LOCK_DEADLOCK' } })
		const shim = inngestLikeStep({ retryTransientDbErrors: true })
		let calls = 0
		await expect(shim.step.run('transient', async () => {
			calls += 1
			if (calls === 1) throw transient
			return { ok: true }
		})).resolves.toEqual({ ok: true })
		expect(calls).toBe(2)
		calls = 0
		await expect(shim.step.run('exhausted', async () => { calls += 1; throw transient })).rejects.toBe(transient)
		expect(calls).toBe(4)
		calls = 0
		const permanent = new Error('not a transient database failure')
		await expect(shim.step.run('permanent', async () => { calls += 1; throw permanent })).rejects.toBe(permanent)
		expect(calls).toBe(1)
	})

	it('gives one purchase when the original run races the reconciler', async () => {
		for (let round = 0; round < 5; round += 1) {
			// Each round is the buyer's first purchase of the product.
			await pool.query('DELETE FROM AI_Purchase')
			const id = stranded()
			// Both runs pass every read, then hit the purchase write together.
			const meet = barrier(2)
			const atWrite = async (stepId: string) => {
				if (stepId === 'create a merchant charge and purchase') await meet()
			}
			const reconciler = inngestLikeStep({ beforeStep: atWrite, retryTransientDbErrors: true })
			const original = inngestLikeStep({ beforeStep: atWrite, retryTransientDbErrors: true })

			const [reconciled, originalOutcome] = await Promise.allSettled([
				reconcile(id, reconciler.step),
				originalRun(id, original.step),
			])

			expect(await counts(id)).toEqual({ charges: 1, sessions: 1, purchases: 1 })
			if (reconciled.status === 'rejected') throw reconciled.reason
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
			await pool.query('DELETE FROM AI_Purchase')
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
	/** A purchase this checkout did not create: a gift, coupon or hand fix. */
	async function grantOutOfBand(id: string, createdAt?: string) {
		await pool.query(
			`INSERT INTO AI_Purchase (id, userId, productId, totalAmount, status${createdAt ? ', createdAt' : ''})
				VALUES (?, ?, 'product_reconcile', 0, 'Valid'${createdAt ? ', ?' : ''})`,
			createdAt ? [id, BUYER_ID, createdAt] : [id, BUYER_ID],
		)
	}

	it('holds when the buyer already got the product another way', async () => {
		const id = stranded()
		await grantOutOfBand('purch_manual')
		const run = inngestLikeStep()

		expect(await reconcile(id, run.step)).toEqual({
			status: 'held',
			checkoutSessionId: id,
			chargeId: `ch_${id.slice(3)}`,
			reason: 'buyer_already_has_product',
			purchaseIds: ['purch_manual'],
		})
		// Held before the handler ran: no user, customer or charge writes.
		expect(run.ran).toEqual([
			'reconcile: load checkout session',
			'reconcile: re-check fulfillment',
		])
		expect(run.sent).toEqual([])
		expect(await counts(id)).toEqual({ charges: 0, sessions: 0, purchases: 0 })
	})

	it('holds when a hand fix lands between the re-check and the write', async () => {
		const id = stranded()
		const run = inngestLikeStep({
			beforeStep: async (stepId) => {
				if (stepId === 'create a merchant charge and purchase')
					await grantOutOfBand('purch_hand_fix')
			},
		})

		expect(await reconcile(id, run.step)).toMatchObject({
			status: 'held',
			reason: 'buyer_already_has_product',
			purchaseIds: ['purch_hand_fix'],
		})
		// The guard used the handler's resolved buyer and product, and stopped
		// the handler before it could announce a purchase.
		expect(run.sent).toEqual([])
		expect(await counts(id)).toEqual({ charges: 0, sessions: 0, purchases: 0 })
	})

	it('saves a verified ledger row from the reconciler new-purchase event', async () => {
		await pool.query("INSERT INTO AI_Product (id, name, type, status, fields) VALUES (?, 'Fixture C5', 'cohort', 1, JSON_OBJECT())", [C5_PRODUCT_ID])
		await pool.query("UPDATE AI_MerchantProduct SET productId = ? WHERE id = 'mp_reconcile'", [C5_PRODUCT_ID])
		const id = stranded({ metadata: {
			...checkoutSession('cs_template').metadata!, productId: C5_PRODUCT_ID,
			cbPricingContract: 'v2-decision', decisionRef: 'c5d1.0123456789abcdef.-',
			engineVersion: 'engine-fixture', policyVersion: 'policy-fixture',
			expectedTotalCents: '29900', accessRestriction: 'none',
		} })
		const run = inngestLikeStep()
		const fulfilled = await reconcile(id, run.step, () => false)
		expect(fulfilled.status).toBe('fulfilled')
		const announced = run.sent.find(event => event.payload.name === 'commerce/new-purchase-created')!
		expect(announced.payload.data).toMatchObject({ checkoutSessionId: id })
		const store = c5DecisionStoreOn(database as unknown as DbExecutor)
		await expect(recordC5PurchaseDecision({
			purchaseId: announced.payload.data.purchaseId as string,
			checkoutSessionId: id, store, now: () => now,
			getCheckoutSession: paymentProvider.options.paymentsAdapter.getCheckoutSession,
		})).resolves.toMatchObject({ status: 'saved', verdict: { kind: 'clean' } })
		await expect(store.purchase(announced.payload.data.purchaseId as string)).resolves.toMatchObject({
			decision: { checkoutSessionId: id, decisionRef: 'c5d1.0123456789abcdef.-' },
		})
	})

	it('still fulfills when the buyer owned the product before this checkout', async () => {
		const id = stranded()
		// Bought long before the session opened: not this checkout's business.
		await grantOutOfBand('purch_old', '2026-01-01 00:00:00.000')

		expect(await reconcile(id, inngestLikeStep().step)).toMatchObject({
			status: 'fulfilled',
		})
		expect(await counts(id)).toEqual({ charges: 1, sessions: 1, purchases: 1 })
	})

	describe('a product whose duplicates are flagged after payment', () => {
		// C5's policy: fulfill a paid order, then let the post-payment check
		// flag the duplicate. The fixture product stands in for C5.
		const fulfillAndFlag = () => false
		const duplicateCheck = async (purchaseId: string) => {
			const store = c5DecisionStoreOn(
				database as unknown as DbExecutor,
				'product_reconcile',
			)
			const purchase = await store.purchase(purchaseId)
			return checkC5Duplicate(store, purchase!)
		}

		it('fulfills instead of holding, and the duplicate check counts the sibling', async () => {
			const id = stranded()
			await grantOutOfBand('purch_sibling', '2026-10-09 21:55:00.000')
			const run = inngestLikeStep()

			const result = await reconcile(id, run.step, fulfillAndFlag)

			expect(result).toMatchObject({ status: 'fulfilled' })
			expect(await counts(id)).toEqual({ charges: 1, sessions: 1, purchases: 1 })
			// The decision recorder runs on this event for both fulfillment paths.
			expect(run.sent.map((event) => event.payload.name)).toEqual([
				'commerce/new-purchase-created',
			])
			await expect(
				duplicateCheck((result as { purchaseId: string }).purchaseId),
			).resolves.toEqual({
				kind: 'duplicate',
				duplicateOf: ['purch_sibling'],
				reasons: ['second-individual-c5'],
			})
		})

		it('fulfills when a sibling lands between the re-check and the write', async () => {
			const id = stranded()
			const run = inngestLikeStep({
				beforeStep: async (stepId) => {
					if (stepId === 'create a merchant charge and purchase')
						await grantOutOfBand('purch_racing', '2026-10-09 21:59:00.000')
				},
			})

			const result = await reconcile(id, run.step, fulfillAndFlag)

			expect(result).toMatchObject({ status: 'fulfilled' })
			await expect(
				duplicateCheck((result as { purchaseId: string }).purchaseId),
			).resolves.toMatchObject({ kind: 'duplicate', duplicateOf: ['purch_racing'] })
		})

		it('keeps the insert-only decision after stale geo writes replace Purchase.fields', async () => {
			await pool.query(
				`INSERT INTO AI_Purchase (id, userId, productId, totalAmount, status, fields)
					VALUES ('purch_fields', ?, 'product_reconcile', 0, 'Valid', JSON_OBJECT('benefit', 'kept'))`,
				[BUYER_ID],
			)
			const store = c5DecisionStoreOn(
				database as unknown as DbExecutor,
				'product_reconcile',
			)
			const decision = {
				v: 1 as const,
				decisionRef: 'c5d1.0123456789abcdef.purch_cc',
				creditSource: 'purch_cc',
				codeRef: null,
				basis: null,
				contract: 'v2-decision',
				engineVersion: 'engine-test',
				policyVersion: 'policy-test',
				accessRestriction: 'none' as const,
				expectedTotalCents: 1,
				checkoutSessionId: 'cs_fields',
				savedAt: now.toISOString(),
			}
			await store.saveDecision('purch_fields', decision)
			// Geo planned this write before the decision was saved. It writes
			// only its own keys, so it cannot drop keys saved since.
			await persistPurchaseGeoWrite({
				purchaseId: 'purch_fields',
				plan: { skip: false, reason: null, city: 'Portland', state: 'OR', ipAddress: null,
					location: { lat: 45.5, lng: -122.6, city: 'Portland', region: 'OR', precision: 'city' },
					source: 'stripe-billing' },
			})
			await store.markDuplicate('purch_fields', ['purch_other'])

			const [rows] = await pool.query<RowDataPacket[]>(
				"SELECT fields FROM AI_Purchase WHERE id = 'purch_fields'",
			)
			const fields =
				typeof rows[0]!.fields === 'string'
					? JSON.parse(rows[0]!.fields)
					: rows[0]!.fields
			expect(fields).toMatchObject({
				benefit: 'kept',
				c5DuplicateOf: ['purch_other'],
			})
			expect(fields).not.toHaveProperty('c5Decision')
			await expect(store.saveDecision('purch_fields', { ...decision, savedAt: '2030-01-01T00:00:00Z' })).resolves.toBe('saved')
			await expect(store.saveDecision('purch_fields', { ...decision, decisionRef: 'c5d1.ffffffffffffffff.other', creditSource: 'other' })).resolves.toBe('conflict')
			await expect(store.purchase('purch_fields')).resolves.toMatchObject({
				decision,
			})
			await expect(store.spentBy('purch_cc')).resolves.toEqual(['purch_fields'])
			await expect(store.spentBy('purch_unspent')).resolves.toEqual([])
			const [indexes] = await pool.query<RowDataPacket[]>('SHOW INDEX FROM AI_PurchaseDecision')
			expect(indexes.map(row => row.Key_name)).toContain('PurchaseDecision_creditSource_idx')
			expect(indexes.map(row => row.Key_name)).toContain('PurchaseDecision_codeRef_idx')
			await pool.query('DELETE FROM AI_PurchaseDecision')
			const replays = await Promise.all([
				store.saveDecision('purch_fields', decision),
				store.saveDecision('purch_fields', { ...decision, decisionRef: 'c5d1.ffffffffffffffff.other', creditSource: 'other' }),
			])
			expect(replays.sort()).toEqual(['conflict', 'saved'])
			const [count] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM AI_PurchaseDecision')
			expect(Number(count[0]!.n)).toBe(1)
		})

		it('counts a sibling bought inside the 48-hour lookback', async () => {
			// A session found near the edge of the reconcile window, with a
			// sibling bought a day after it opened.
			const id = stranded({
				created: Math.floor(now.getTime() / 1000) - 47 * 60 * 60,
			})
			await grantOutOfBand('purch_day_later', '2026-10-08 23:00:00.000')

			const held = await reconcile(id, inngestLikeStep().step)
			expect(held).toMatchObject({
				status: 'held',
				purchaseIds: ['purch_day_later'],
			})

			const result = await reconcile(id, inngestLikeStep().step, fulfillAndFlag)
			expect(result).toMatchObject({ status: 'fulfilled' })
			await expect(
				duplicateCheck((result as { purchaseId: string }).purchaseId),
			).resolves.toMatchObject({
				kind: 'duplicate',
				duplicateOf: ['purch_day_later'],
			})
		})
	})

	it('finds a fulfilled session with indexed charge lookups only', async () => {
		const id = stranded()
		await reconcile(id, inngestLikeStep().step)
		const chargeId = `ch_${id.slice(3)}`
		const queries: string[] = []
		const tracing = drizzle(pool, {
			schema,
			mode: 'planetscale',
			logger: { logQuery: (query) => queries.push(query) },
		}) as unknown as MySqlDatabase<any, any, typeof schema>

		const state = await inspectCheckoutFulfillment(tracing, {
			checkoutSessionId: id,
			chargeId,
		})
		expect(state.purchaseIds).toHaveLength(1)
		// No MerchantSession scan and no OR across the two purchase columns.
		expect(queries).toHaveLength(2)
		expect(queries.join('\n')).not.toContain('AI_MerchantSession')
		expect(queries.join('\n')).not.toMatch(/\bor\b/i)
		for (const query of queries) {
			const [plan] = await pool.query<RowDataPacket[]>(
				`EXPLAIN ${query}`,
				query.includes('AI_MerchantCharge') ? [chargeId] : [state.chargeIds[0]],
			)
			expect(plan.map((row) => row.type)).not.toContain('ALL')
		}
	})
})
