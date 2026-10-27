import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { mysqlTable } from '@/db/mysql-table'
import * as schema from '@/db/schema'
import { validateMySqlIntegrationServerUrl } from '@/lib/team-purchase-mysql-test-guard'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'
import Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'
import { StripePaymentAdapter } from '@coursebuilder/commerce/stripe-provider'
import { courseBuilderCoreFunctions } from '@coursebuilder/server'
import { logger } from '@coursebuilder/utils/logger'

import { SELF_SERVE_TEAM_INVOICE_SOURCE } from './create-team-invoice'
import { createAndSendTeamInvoice } from './stripe-team-invoice'

/**
 * OL-094 replay: a paid team invoice whose `accessProvisioning` starts with
 * `manual_` must not fulfill again. Real Stripe sandbox invoices, the
 * `invoice.payment_succeeded` handler ai-hero registers (via
 * `courseBuilderCoreFunctions`), and the real Drizzle adapter on a disposable
 * database. Skipped unless all three are set:
 *
 *   AIH_TEST_MYSQL_SERVER_URL=$(scripts/test-mysql.sh up | cut -d= -f2-) \
 *   AIH_STRIPE_SANDBOX_KEY=sk_test_... \
 *   AIH_SANDBOX_STRIPE_PRODUCT=prod_... \
 *     pnpm vitest run src/lib/team-invoice/invoice-skip-guard.sandbox.mysql.test.ts
 *
 * Refuses a live key and the shared 3307 database.
 */

const KEY = process.env.AIH_STRIPE_SANDBOX_KEY ?? ''
const PRODUCT = process.env.AIH_SANDBOX_STRIPE_PRODUCT ?? ''
const SERVER_URL = process.env.AIH_TEST_MYSQL_SERVER_URL ?? ''
const isTestKey = /^(sk|rk)_test_/.test(KEY)
const RUN = `skip-guard-${randomUUID()}`
const RIG = { rig: 'aihero-commerce', rig_run: RUN }
const APP_PRODUCT_ID = 'product-skip-guard-team'
const SEATS = 5

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
	merchantPrice: schema.merchantPrice,
	coupon: schema.coupon,
	purchases: schema.purchases,
	purchaseUserTransfer: schema.purchaseUserTransfer,
	products: schema.products,
	prices: schema.prices,
	upgradableProducts: schema.upgradableProducts,
	contentResource: schema.contentResource,
	contentResourceProduct: schema.contentResourceProduct,
	contentResourceResource: schema.contentResourceResource,
}

const stripe = isTestKey
	? new Stripe(KEY, { apiVersion: '2024-06-20' as Stripe.LatestApiVersion })
	: (null as unknown as Stripe)

const handler = courseBuilderCoreFunctions.find(
	(fn) => fn.config.id === 'stripe-invoice-payment-succeeded',
)!.handler as (input: any) => Promise<any>

type CountRow = RowDataPacket & {
	purchases: number
	coupons: number
	maxUses: number | null
	allPurchases: number
	allCoupons: number
}

async function listPrice() {
	const prices = await stripe.prices.list({
		product: PRODUCT,
		active: true,
		type: 'one_time',
		currency: 'usd',
		limit: 1,
	})
	const price = prices.data[0]
	if (!price?.unit_amount) throw new Error(`No one-time USD price on ${PRODUCT}`)
	return { id: price.id, unitAmount: price.unit_amount }
}

async function paymentSucceededEvent(invoiceId: string) {
	for (let attempt = 0; attempt < 20; attempt++) {
		const events = await stripe.events.list({
			type: 'invoice.payment_succeeded',
			limit: 20,
		})
		const event = events.data.find(
			(candidate) => (candidate.data.object as Stripe.Invoice).id === invoiceId,
		)
		if (event) return event
		await new Promise((resolve) => setTimeout(resolve, 1_500))
	}
	throw new Error(`No invoice.payment_succeeded event for ${invoiceId}`)
}

describe.skipIf(!isTestKey || !PRODUCT || !SERVER_URL)(
	'OL-094 manual access provisioning skip, sandbox Stripe + real adapter',
	() => {
		let server: Pool
		let pool: Pool
		let name: string
		let adapter: ReturnType<typeof DrizzleAdapter>

		async function counts(email: string) {
			const [[row]] = await pool.query<CountRow[]>(
				`SELECT
					(SELECT COUNT(*) FROM AI_Purchase p JOIN AI_User u ON u.id = p.userId
						WHERE u.email = ?) AS purchases,
					(SELECT COUNT(*) FROM AI_Coupon c JOIN AI_Purchase p ON p.bulkCouponId = c.id
						JOIN AI_User u ON u.id = p.userId WHERE u.email = ?) AS coupons,
					(SELECT SUM(c.maxUses) FROM AI_Coupon c JOIN AI_Purchase p ON p.bulkCouponId = c.id
						JOIN AI_User u ON u.id = p.userId WHERE u.email = ?) AS maxUses,
					(SELECT COUNT(*) FROM AI_Purchase) AS allPurchases,
					(SELECT COUNT(*) FROM AI_Coupon) AS allCoupons`,
				[email, email, email],
			)
			return {
				purchases: Number(row!.purchases),
				bulkCoupons: Number(row!.coupons),
				bulkCouponMaxUses: Number(row!.maxUses ?? 0),
				allPurchases: Number(row!.allPurchases),
				allCoupons: Number(row!.allCoupons),
			}
		}

		async function payTeamInvoice(email: string, accessProvisioning: string) {
			const price = await listPrice()
			const created = await createAndSendTeamInvoice(stripe, {
				orderKey: `${RUN}-${accessProvisioning}`,
				billingEmail: email,
				companyName: 'Skip Guard Co',
				due: { kind: 'days', days: 30 },
				stripePriceId: price.id,
				stripeProductId: PRODUCT,
				quantity: SEATS,
				discount: { kind: 'none' },
				expectedTotal: price.unitAmount * SEATS,
				metadata: {
					...RIG,
					source: SELF_SERVE_TEAM_INVOICE_SOURCE,
					medium: 'team_invoice',
					campaign: 'team_sale',
					app: 'ai-hero',
					productId: APP_PRODUCT_ID,
					seats: String(SEATS),
					policy: 'sandbox-skip-guard',
					accessProvisioning,
				},
			})
			const method = await stripe.paymentMethods.attach('pm_card_visa', {
				customer: created.customerId,
			})
			const paid = await stripe.invoices.pay(created.invoiceId, {
				payment_method: method.id,
			})
			expect(paid.status).toBe('paid')
			return { invoiceId: created.invoiceId, event: await paymentSucceededEvent(created.invoiceId) }
		}

		async function fulfill(event: Stripe.Event) {
			const sendEvent = vi.fn()
			const result = await handler({
				event: {
					name: 'stripe/invoice-payment-succeeded',
					data: { stripeEvent: event, txnId: RUN },
				},
				step: {
					run: async (_name: string, fn: () => unknown) => fn(),
					sendEvent,
				},
				db: adapter,
				paymentProvider: {
					options: {
						paymentsAdapter: new StripePaymentAdapter({
							stripeToken: KEY,
							stripeWebhookSecret: 'whsec_unused_in_this_test',
						}),
					},
				},
				notificationProvider: undefined,
			})
			return { result, sendEvent }
		}

		beforeAll(async () => {
			const safe = validateMySqlIntegrationServerUrl(SERVER_URL, {
				nodeEnv: process.env.NODE_ENV,
				vercelEnv: process.env.VERCEL_ENV,
			})
			if (safe.port === '3307') throw new Error('refusing the shared 3307 database')
			server = mysql.createPool({ uri: safe.toString(), timezone: 'Z' })
			name = `aih_skip_guard_${randomUUID().replaceAll('-', '')}`
			await server.query(
				`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
			)
			const target = new URL(safe)
			target.pathname = `/${name}`
			pool = preserveQueryResultShape(
				mysql.createPool({ uri: target.toString(), timezone: 'Z', connectionLimit: 4 }),
			)
			const acquire = pool.getConnection.bind(pool)
			pool.getConnection = (async () =>
				preserveQueryResultShape(await acquire())) as typeof pool.getConnection
			const statements = await generateMySQLMigration(
				await generateMySQLDrizzleJson({}),
				await generateMySQLDrizzleJson(tables),
			)
			for (const statement of statements) await pool.query(statement)

			const database = drizzle(pool, { schema, mode: 'planetscale' }) as unknown as MySqlDatabase<any, any, typeof schema>
			adapter = DrizzleAdapter<MySqlDatabase<any, any, typeof schema>>(database, mysqlTable)

			await pool.query(
				"INSERT INTO AI_MerchantAccount (id, status, label, identifier) VALUES ('ma_skip', 1, 'stripe', 'acct_skip')",
			)
			await pool.query(
				"INSERT INTO AI_Product (id, name, type, status, fields) VALUES (?, 'Skip Guard Team Product', 'self-paced', 1, JSON_OBJECT('slug', 'skip-guard'))",
				[APP_PRODUCT_ID],
			)
			await pool.query(
				"INSERT INTO AI_MerchantProduct (id, merchantAccountId, productId, status, identifier) VALUES ('mp_skip', 'ma_skip', ?, 1, ?)",
				[APP_PRODUCT_ID, PRODUCT],
			)
		}, 60_000)

		afterAll(async () => {
			await pool?.end()
			if (server && name) await server.query(`DROP DATABASE \`${name}\``)
			await server?.end()
		})

		it(
			'skips a manual_early_access invoice for a team that already has access',
			async () => {
				const email = `team-${RUN}-manual@example.test`
				// The early grant: a purchase and bulk coupon made before payment.
				await pool.query("INSERT INTO AI_User (id, email, name) VALUES ('user_manual', ?, 'Early Team')", [email])
				await pool.query(
					"INSERT INTO AI_Coupon (id, maxUses, usedCount, status, `default`, restrictedToProductId) VALUES ('coupon_manual', ?, 0, 1, false, ?)",
					[SEATS, APP_PRODUCT_ID],
				)
				await pool.query(
					"INSERT INTO AI_Purchase (id, userId, productId, totalAmount, status, bulkCouponId) VALUES ('purchase_manual', 'user_manual', ?, 0, 'Valid', 'coupon_manual')",
					[APP_PRODUCT_ID],
				)
				const info = vi.spyOn(logger, 'info')
				const before = await counts(email)
				const { invoiceId, event } = await payTeamInvoice(email, 'manual_early_access')
				const { result, sendEvent } = await fulfill(event)
				const after = await counts(email)

				expect(result).toEqual({ skipped: true, reason: 'manual-access-provisioning' })
				expect(info).toHaveBeenCalledWith(
					'invoice.skipped.manual-access-provisioning',
					expect.objectContaining({ invoiceId }),
				)
				expect(sendEvent).not.toHaveBeenCalled()
				expect(after).toEqual(before)
				console.info(JSON.stringify({ proof: 'manual-skip', run: RUN, invoiceId, event: event.id, before, after }))
				info.mockRestore()
			},
			90_000,
		)

		it(
			'fulfills an automatic_on_invoice_payment_succeeded team invoice exactly once',
			async () => {
				const email = `team-${RUN}-auto@example.test`
				const before = await counts(email)
				const { invoiceId, event } = await payTeamInvoice(
					email,
					'automatic_on_invoice_payment_succeeded',
				)
				const { result, sendEvent } = await fulfill(event)
				const after = await counts(email)

				expect(result?.skipped).toBeUndefined()
				expect(after).toEqual({
					purchases: 1,
					bulkCoupons: 1,
					bulkCouponMaxUses: SEATS,
					allPurchases: before.allPurchases + 1,
					allCoupons: before.allCoupons + 1,
				})
				expect(sendEvent).toHaveBeenCalledWith(
					'commerce/new-purchase-created',
					expect.objectContaining({
						data: expect.objectContaining({ invoiceId, quantity: SEATS }),
					}),
				)
				console.info(JSON.stringify({ proof: 'automatic-fulfill', run: RUN, invoiceId, event: event.id, before, after }))
			},
			90_000,
		)
	},
)
