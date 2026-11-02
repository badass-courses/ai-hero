import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { mysqlTable } from '@/db/mysql-table'
import * as schema from '@/db/schema'
import { validateMySqlIntegrationServerUrl } from '@/lib/team-purchase-mysql-test-guard'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'

/**
 * The buyer pricing facts that front-desk, C5 checkout and the team invoice
 * read, through the real `pricingFactsSourceLayer` on a disposable database
 * and real Stripe sandbox reads. Only `@/db` (the disposable database), the
 * Stripe client (the sandbox key), the gift cookie and Redis are stand-ins.
 * This file imports no Effect, so the same test runs on either Effect major.
 * Skipped unless both are set:
 *
 *   AIH_TEST_MYSQL_SERVER_URL=$(scripts/test-mysql.sh up | cut -d= -f2-) \
 *   AIH_STRIPE_SANDBOX_KEY=sk_test_... \
 *     pnpm vitest run src/app/api/front-desk/pricing-facts.sandbox.mysql.test.ts
 *
 * Refuses a live key and the shared 3307 database. Sandbox objects carry
 * `rig=aihero-commerce` and a `rig_run`.
 */

const KEY = process.env.AIH_STRIPE_SANDBOX_KEY ?? ''
const SERVER_URL = process.env.AIH_TEST_MYSQL_SERVER_URL ?? ''
const isTestKey = /^(sk|rk)_test_/.test(KEY)
const RUN = `front-desk-facts-${randomUUID()}`
const RIG = { rig: 'aihero-commerce', rig_run: RUN }
const C5 = 'product-s00zs'
const CRASH_COURSE = 'product-ma254'
const C1 = 'product-3vfob'
const TEAM_SEATS = 7
const EMAIL = 'facts-buyer@example.test'

const state = vi.hoisted(() => ({
	db: undefined as unknown,
	adapter: undefined as unknown,
}))
vi.mock('@/db', () => ({
	get db() {
		return state.db
	},
	get courseBuilderAdapter() {
		return state.adapter
	},
}))
// hooks.ts reads the client once at import, so build the sandbox one here.
vi.mock('@/coursebuilder/stripe-provider', async () => {
	const { default: Stripe } = await import('stripe')
	const key = process.env.AIH_STRIPE_SANDBOX_KEY ?? ''
	return {
		stripeProvider: {
			options: {
				paymentsAdapter: {
					stripe: /^(sk|rk)_test_/.test(key)
						? new Stripe(key, {
								apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
							})
						: null,
				},
			},
		},
	}
})
// Next request cookies and Redis are not part of the facts read.
vi.mock('@/lib/c5-pricing/gift-server', () => ({
	signedGiftFact: vi.fn(async () => ({
		value: null,
		sourceRefs: ['gift:no-valid-cookie'],
	})),
}))
vi.mock('@/server/redis-client', () => ({ redis: {} }))

import { hooks } from './hooks'
import { teamInvoiceServerDeps } from '@/lib/team-invoice/team-invoice-server'

const { generateMySQLDrizzleJson, generateMySQLMigration } = createRequire(
	import.meta.url,
)('drizzle-kit/api') as typeof import('drizzle-kit/api')

const tables = {
	users: schema.users,
	roles: schema.roles,
	userRoles: schema.userRoles,
	merchantAccount: schema.merchantAccount,
	merchantProduct: schema.merchantProduct,
	merchantCustomer: schema.merchantCustomer,
	merchantCharge: schema.merchantCharge,
	merchantSession: schema.merchantSession,
	merchantCoupon: schema.merchantCoupon,
	coupon: schema.coupon,
	purchases: schema.purchases,
	purchaseUserTransfer: schema.purchaseUserTransfer,
	purchaseDecision: schema.purchaseDecision,
	products: schema.products,
	prices: schema.prices,
}

type Database = MySqlDatabase<any, any, typeof schema>

const stripe = isTestKey
	? new Stripe(KEY, { apiVersion: '2024-06-20' as Stripe.LatestApiVersion })
	: (null as unknown as Stripe)

describe.skipIf(!isTestKey || !SERVER_URL)(
	'buyer pricing facts, sandbox Stripe + disposable database',
	() => {
		let server: Pool
		let pool: Pool
		let name: string
		const ids = {} as Record<'product' | 'charge' | 'session', string>
		// Stripe ids differ per run; the facts are compared without them.
		const stable = (value: unknown) =>
			JSON.parse(
				Object.entries(ids).reduce(
					(json, [key, id]) => json.replaceAll(id, `<${key}>`),
					JSON.stringify(value),
				),
			)

		beforeAll(async () => {
			const safe = validateMySqlIntegrationServerUrl(SERVER_URL, {
				nodeEnv: process.env.NODE_ENV,
				vercelEnv: process.env.VERCEL_ENV,
			})
			if (safe.port === '3307')
				throw new Error('refusing the shared 3307 database')
			server = mysql.createPool({ uri: safe.toString(), timezone: 'Z' })
			name = `aih_front_desk_facts_${randomUUID().replaceAll('-', '')}`
			await server.query(
				`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
			)
			const target = new URL(safe)
			target.pathname = `/${name}`
			pool = preserveQueryResultShape(
				mysql.createPool({
					uri: target.toString(),
					timezone: 'Z',
					connectionLimit: 4,
				}),
			)
			const acquire = pool.getConnection.bind(pool)
			pool.getConnection = (async () =>
				preserveQueryResultShape(await acquire())) as typeof pool.getConnection
			const statements = await generateMySQLMigration(
				await generateMySQLDrizzleJson({}),
				await generateMySQLDrizzleJson(tables),
			)
			for (const statement of statements) await pool.query(statement)
			const database = drizzle(pool, {
				schema,
				mode: 'planetscale',
			}) as unknown as MySqlDatabase<any, any, typeof schema>
			state.db = database
			state.adapter = DrizzleAdapter<MySqlDatabase<any, any, typeof schema>>(
				database,
				mysqlTable,
			)

			// A paid sandbox charge and an open Checkout Session for a
			// Crash-Course-shaped product: the settlement read retrieves both.
			const product = await stripe.products.create({
				name: 'Facts Proof Crash Course',
				metadata: RIG,
			})
			const price = await stripe.prices.create({
				product: product.id,
				unit_amount: 9_900,
				currency: 'usd',
				metadata: RIG,
			})
			const intent = await stripe.paymentIntents.create({
				amount: 9_900,
				currency: 'usd',
				payment_method: 'pm_card_visa',
				payment_method_types: ['card'],
				confirm: true,
				metadata: RIG,
			})
			const session = await stripe.checkout.sessions.create({
				mode: 'payment',
				line_items: [{ price: price.id, quantity: 1 }],
				success_url: 'https://example.test/thanks',
				metadata: RIG,
			})
			ids.product = product.id
			ids.charge = String(intent.latest_charge)
			ids.session = session.id

			const q = (sql: string, values: unknown[] = []) => pool.query(sql, values)
			await q(
				"INSERT INTO AI_MerchantAccount (id, status, label, identifier) VALUES ('ma_facts', 1, 'stripe', 'acct_facts')",
			)
			await q("INSERT INTO AI_User (id, email, name) VALUES ('user_facts', ?, 'Facts Buyer')", [EMAIL])
			await q(
				"INSERT INTO AI_MerchantCustomer (id, userId, merchantAccountId, identifier, status) VALUES ('mcus_facts', 'user_facts', 'ma_facts', 'cus_facts', 1)",
			)
			for (const [id, productName] of [
				[C5, 'C5'],
				[CRASH_COURSE, 'Crash Course'],
				[C1, 'C1'],
			])
				await q(
					"INSERT INTO AI_Product (id, name, type, status, quantityAvailable, fields) VALUES (?, ?, 'self-paced', 1, -1, JSON_OBJECT())",
					[id, productName],
				)
			await q(
				"INSERT INTO AI_Price (id, status, productId, unitAmount, fields) VALUES ('price_facts_c5', 1, ?, '199.00', JSON_OBJECT())",
				[C5],
			)
			await q(
				"INSERT INTO AI_MerchantProduct (id, merchantAccountId, productId, status, identifier) VALUES ('mp_facts_cc', 'ma_facts', ?, 1, ?)",
				[CRASH_COURSE, product.id],
			)
			await q(
				"INSERT INTO AI_MerchantCharge (id, status, identifier, userId, merchantAccountId, merchantProductId, merchantCustomerId) VALUES ('mch_facts', 1, ?, 'user_facts', 'ma_facts', 'mp_facts_cc', 'mcus_facts')",
				[ids.charge],
			)
			await q(
				"INSERT INTO AI_MerchantSession (id, identifier, merchantAccountId) VALUES ('msess_facts', ?, 'ma_facts')",
				[session.id],
			)
			await q(
				"INSERT INTO AI_Coupon (id, status, maxUses, usedCount, restrictedToProductId) VALUES ('coupon_facts_team', 1, ?, 0, ?)",
				[TEAM_SEATS, C5],
			)
			await q(
				"INSERT INTO AI_Purchase (id, userId, productId, totalAmount, status, bulkCouponId, createdAt) VALUES ('purchase_facts_team', 'user_facts', ?, '995.00', 'Valid', 'coupon_facts_team', '2026-09-01 00:00:00')",
				[C5],
			)
			await q(
				"INSERT INTO AI_Purchase (id, userId, productId, totalAmount, status, merchantChargeId, merchantSessionId, createdAt) VALUES ('purchase_facts_cc', 'user_facts', ?, '99.00', 'Valid', 'mch_facts', 'msess_facts', '2026-08-20 00:00:00')",
				[CRASH_COURSE],
			)
			await q(
				"INSERT INTO AI_Purchase (id, userId, productId, totalAmount, status, createdAt) VALUES ('purchase_facts_c1', 'user_facts', ?, '0.00', 'Valid', '2026-01-10 00:00:00')",
				[C1],
			)
		}, 120_000)

		afterAll(async () => {
			if (ids.session) await stripe.checkout.sessions.expire(ids.session).catch(() => {})
			if (ids.product)
				await stripe.products.update(ids.product, { active: false }).catch(() => {})
			await pool?.end()
			if (server && name) await server.query(`DROP DATABASE \`${name}\``)
			await server?.end()
		})

		it('front-desk reads the team seats, alumni and credit evidence', async () => {
			const facts = await hooks.pricingFacts({
				email: EMAIL,
				productId: C5,
				quantity: 5,
				orderKind: 'team',
			})
			expect(facts?.buyer.userId).toBe('user_facts')
			expect(facts?.product).toMatchObject({
				merchantPriceId: 'price_facts_c5',
				merchantUnit: 19_900,
			})
			expect(facts?.facts.existingSeats).toEqual({
				value: TEAM_SEATS,
				sourceRefs: ['ai-hero:purchase:purchase_facts_team'],
			})
			// The settlement reads succeeded: an open Checkout Session proves no
			// paid amount, which is ambiguity, not an unavailable source.
			expect(facts?.facts.credit).toEqual({ gap: 'PaymentAmbiguous' })
			expect(stable(facts)).toMatchSnapshot()
		}, 60_000)

		it('the team invoice reads the same existing seats', async () => {
			const { buyer } = teamInvoiceServerDeps()
			expect(await buyer(EMAIL, C5)).toEqual({
				existingSeats: TEAM_SEATS,
				userId: 'user_facts',
			})
			expect(await buyer('nobody@example.test', C5)).toEqual({
				existingSeats: 0,
			})
		}, 60_000)

		it('a failed source read stays contained at every caller', async () => {
			const { buyer } = teamInvoiceServerDeps()
			const working = state.db
			const down = mysql.createPool({
				uri: 'mysql://root:x@127.0.0.1:1/unreachable',
				connectTimeout: 500,
			})
			const unreachable = drizzle(down, {
				schema,
				mode: 'planetscale',
			}) as unknown as Database
			state.db = unreachable
			state.adapter = DrizzleAdapter<Database>(unreachable, mysqlTable)
			try {
				// The team invoice treats an unreadable buyer as unknown seats.
				expect(await buyer(EMAIL, C5)).toBeNull()
				// front-desk's facade and C5 checkout map any rejection to their
				// own failure code, so only the fact of rejection matters here.
				await expect(
					hooks.pricingFacts({
						email: EMAIL,
						productId: C5,
						quantity: 1,
						orderKind: 'individual',
					}),
				).rejects.toBeDefined()
			} finally {
				state.db = working
				state.adapter = DrizzleAdapter<Database>(working as Database, mysqlTable)
				await down.end()
			}
		}, 60_000)
	},
)
