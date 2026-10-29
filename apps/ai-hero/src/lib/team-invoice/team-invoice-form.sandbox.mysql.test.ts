import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { mysqlTable } from '@/db/mysql-table'
import * as schema from '@/db/schema'
import { validateMySqlIntegrationServerUrl } from '@/lib/team-purchase-mysql-test-guard'
import { count, eq } from 'drizzle-orm'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'
import Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'
import { formatPricesForProduct } from '@coursebuilder/commerce'
import { StripePaymentAdapter } from '@coursebuilder/commerce/stripe-provider'
import { courseBuilderCoreFunctions } from '@coursebuilder/server'

import {
	confirmTeamInvoice,
	startTeamInvoice,
	type TeamInvoiceDeps,
} from './create-team-invoice'
import { loadTeamInvoiceProduct } from './load-product'
import type { TeamInvoiceResult } from './schema'
import { createAndSendTeamInvoice } from './stripe-team-invoice'
import { appBulkPriceSource } from './team-price-source'

/**
 * Team invoice form flow in the Stripe sandbox, on a disposable database.
 * The app's own `startTeamInvoice` and `confirmTeamInvoice`, the real
 * `loadTeamInvoiceProduct` (the code path #574 fixes), the real app-bulk
 * price source over `formatPricesForProduct`, the real Drizzle adapter and
 * Course Builder's invoice fulfillment. Redis and the confirmation email are
 * in-memory stand-ins, so the confirm token is read straight off the email.
 * The catalog is synthetic and Crash-Course-shaped: self-paced, unlimited,
 * the app's generic bulk ladder. No production amounts. Skipped unless both
 * of these are set:
 *
 *   AIH_TEST_MYSQL_SERVER_URL=$(scripts/test-mysql.sh up | cut -d= -f2-) \
 *   AIH_STRIPE_SANDBOX_KEY=sk_test_... \
 *     pnpm vitest run src/lib/team-invoice/team-invoice-form.sandbox.mysql.test.ts
 *
 * Refuses a live key and the shared 3307 database.
 */

const KEY = process.env.AIH_STRIPE_SANDBOX_KEY ?? ''
const SERVER_URL = process.env.AIH_TEST_MYSQL_SERVER_URL ?? ''
const isTestKey = /^(sk|rk)_test_/.test(KEY)
const RUN = `team-form-${randomUUID()}`
const RIG = { rig: 'aihero-commerce', rig_run: RUN }
const APP_PRODUCT_ID = 'product-form-shape'
const SEATS = 5
const LIST_CENTS = 19_900

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

describe.skipIf(!isTestKey || !SERVER_URL)(
	'team invoice form flow, sandbox Stripe + real adapter',
	() => {
		let server: Pool
		let pool: Pool
		let name: string
		let adapter: ReturnType<typeof DrizzleAdapter>
		let database: MySqlDatabase<any, any, typeof schema>
		const stripeIds = {} as { product: string; price: string; coupon: string }

		const outbox: {
			to: string
			productName: string
			seats: number
			token: string
		}[] = []
		const logs: { event: string; data: Record<string, unknown> }[] = []
		const pending = new Map<string, any>()
		const results = new Map<string, TeamInvoiceResult>()
		const locks = new Set<string>()
		const created: string[] = []

		const bulk = () =>
			appBulkPriceSource({
				formatPrice: (request, sale) =>
					formatPricesForProduct({
						productId: request.productId,
						quantity: request.quantity,
						userId: request.userId,
						...(sale
							? {
									merchantCouponId: sale.merchantCouponId,
									usedCouponId: sale.couponId,
								}
							: {}),
						autoApplyPPP: false,
						ctx: adapter as any,
					}),
				stripeCouponIdFor: async (id) =>
					(await adapter.getMerchantCoupon(id))?.identifier ?? null,
				defaultSaleCoupon: async (productId) => {
					const result = await adapter.getDefaultCoupon([productId])
					const merchantCoupon = result?.defaultMerchantCoupon
					if (!result || !merchantCoupon?.identifier) return null
					return {
						merchantCouponId: merchantCoupon.id,
						couponId: result.defaultCoupon.id,
						stripeCouponId: merchantCoupon.identifier,
						percentageDiscount: merchantCoupon.percentageDiscount
							? Number(merchantCoupon.percentageDiscount)
							: null,
						amountDiscount: merchantCoupon.amountDiscount ?? null,
					}
				},
			})

		const deps = (): TeamInvoiceDeps => ({
			now: () => new Date(),
			rateLimit: async () => true,
			dailyCeiling: async () => true,
			pending: {
				put: async (token, order) => void pending.set(token, order),
				get: async (token) => pending.get(token) ?? null,
			},
			newToken: () => randomBytes(32).toString('base64url'),
			sendConfirmation: async (mail) => void outbox.push(mail),
			idempotency: {
				get: async (key) => results.get(key) ?? null,
				lock: async (key) => !locks.has(key) && Boolean(locks.add(key)),
				unlock: async (key) => void locks.delete(key),
				set: async (key, result) => void results.set(key, result),
			},
			loadProduct: (productId) =>
				loadTeamInvoiceProduct(
					{
						adapter: adapter as any,
						stripe,
						purchaseCount: async (id) =>
							(
								await database
									.select({ count: count() })
									.from(schema.purchases)
									.where(eq(schema.purchases.productId, id))
							)[0]?.count ?? 0,
						openInvoices: async () => [],
					},
					productId,
				),
			buyer: async () => ({ existingSeats: 0 }),
			priceSource: () => bulk(),
			invoicingEnabled: () => true,
			createInvoice: async (input) => {
				const invoice = await createAndSendTeamInvoice(stripe, input)
				created.push(invoice.invoiceId)
				return invoice
			},
			forwardRequest: async () => {
				throw new Error('unexpected forward to support')
			},
			log: (event, data) => void logs.push({ event, data }),
			extraMetadata: RIG,
		})

		const form = (email: string) => ({
			productId: APP_PRODUCT_ID,
			companyName: 'Form Proof Co',
			billingEmail: email,
			seats: SEATS,
			address: { line1: '1 Sandbox Way', city: 'Berlin', country: 'DE' },
			poNumber: 'PO-FORM-1',
			terms: 'net_30' as const,
			timestamp: new Date(Date.now() - 10_000).toISOString(),
		})

		beforeAll(async () => {
			const safe = validateMySqlIntegrationServerUrl(SERVER_URL, {
				nodeEnv: process.env.NODE_ENV,
				vercelEnv: process.env.VERCEL_ENV,
			})
			if (safe.port === '3307')
				throw new Error('refusing the shared 3307 database')
			server = mysql.createPool({ uri: safe.toString(), timezone: 'Z' })
			name = `aih_team_form_${randomUUID().replaceAll('-', '')}`
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
			database = drizzle(pool, {
				schema,
				mode: 'planetscale',
			}) as unknown as MySqlDatabase<any, any, typeof schema>
			adapter = DrizzleAdapter<MySqlDatabase<any, any, typeof schema>>(
				database,
				mysqlTable,
			)

			// Sandbox catalog: a Crash-Course-shaped product at a synthetic $199 and
			// the 15% Stripe coupon behind the app's five-to-nine-seat bulk tier.
			const product = await stripe.products.create({
				name: 'Form Proof Product',
				metadata: RIG,
			})
			const price = await stripe.prices.create({
				product: product.id,
				unit_amount: LIST_CENTS,
				currency: 'usd',
				metadata: RIG,
			})
			const coupon = await stripe.coupons.create({
				percent_off: 15,
				duration: 'once',
				name: 'Form proof bulk 15',
				metadata: RIG,
			})
			stripeIds.product = product.id
			stripeIds.price = price.id
			stripeIds.coupon = coupon.id

			await pool.query(
				"INSERT INTO AI_MerchantAccount (id, status, label, identifier) VALUES ('ma_form', 1, 'stripe', 'acct_form')",
			)
			await pool.query(
				"INSERT INTO AI_Product (id, name, type, status, quantityAvailable, fields) VALUES (?, 'Form Proof Product', 'self-paced', 1, -1, JSON_OBJECT('slug', 'form-proof', 'state', 'published', 'visibility', 'public'))",
				[APP_PRODUCT_ID],
			)
			await pool.query(
				'INSERT INTO AI_Price (id, status, productId, unitAmount, fields) VALUES (\'price_form\', 1, ?, ?, JSON_OBJECT())',
				[APP_PRODUCT_ID, (LIST_CENTS / 100).toFixed(2)],
			)
			await pool.query(
				"INSERT INTO AI_MerchantProduct (id, merchantAccountId, productId, status, identifier) VALUES ('mp_form', 'ma_form', ?, 1, ?)",
				[APP_PRODUCT_ID, product.id],
			)
			await pool.query(
				"INSERT INTO AI_MerchantPrice (id, merchantAccountId, merchantProductId, priceId, status, identifier) VALUES ('mprice_form', 'ma_form', 'mp_form', 'price_form', 1, ?)",
				[price.id],
			)
			await pool.query(
				"INSERT INTO AI_MerchantCoupon (id, identifier, status, merchantAccountId, percentageDiscount, type) VALUES ('mcoupon_bulk_15', ?, 1, 'ma_form', 0.15, 'bulk')",
				[coupon.id],
			)
		}, 90_000)

		afterAll(async () => {
			await pool?.end()
			if (server && name) await server.query(`DROP DATABASE \`${name}\``)
			await server?.end()
		})

		it(
			'sends the form, confirms once, bills the ladder, and fulfils five seats',
			async () => {
				const email = `team-${RUN}@example.test`

				// The #574 path: the real loadProduct finds the Stripe ids.
				const loaded = await deps().loadProduct(APP_PRODUCT_ID)
				expect(loaded).toMatchObject({
					stripePriceId: stripeIds.price,
					stripeProductId: stripeIds.product,
					listUnitAmount: LIST_CENTS,
					purchaseCount: 0,
					heldSeats: 0,
				})

				const started = await startTeamInvoice(
					form(email),
					{ ip: '203.0.113.9' },
					deps(),
				)
				expect(started).toEqual({ kind: 'confirm-sent', email })
				expect(outbox).toHaveLength(1)
				expect(outbox[0]).toMatchObject({
					to: email,
					seats: SEATS,
					productName: 'Form Proof Product',
				})
				expect(created).toHaveLength(0)

				const { token } = outbox[0]!
				const first = await confirmTeamInvoice(token, deps())
				expect(first).toEqual({ kind: 'sent', email })
				expect(created).toHaveLength(1)
				const second = await confirmTeamInvoice(token, deps())
				expect(second).toEqual(first)
				expect(created).toHaveLength(1)

				const invoiceId = created[0]!
				const invoice = await stripe.invoices.retrieve(invoiceId, {
					expand: ['lines.data.price', 'discounts'],
				})
				const expectedTotal = Math.round(LIST_CENTS * SEATS * 0.85)
				expect(invoice.lines.data).toHaveLength(1)
				const line = invoice.lines.data[0]!
				expect(line.quantity).toBe(SEATS)
				expect(line.price?.id).toBe(stripeIds.price)
				expect(line.price?.unit_amount).toBe(LIST_CENTS)
				expect(invoice.total).toBe(expectedTotal)
				expect(invoice.metadata).toMatchObject({
					productId: APP_PRODUCT_ID,
					seats: String(SEATS),
				})
				const discount = invoice.discounts?.[0] as Stripe.Discount | undefined

				const method = await stripe.paymentMethods.attach('pm_card_visa', {
					customer: invoice.customer as string,
				})
				const paid = await stripe.invoices.pay(invoiceId, {
					payment_method: method.id,
				})
				expect(paid.status).toBe('paid')
				expect(paid.amount_paid).toBe(expectedTotal)

				const event = await paymentSucceededEvent(invoiceId)
				const sendEvent = vi.fn()
				await handler({
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

				const [[row]] = await pool.query<
					(RowDataPacket & {
						purchases: number
						coupons: number
						maxUses: number | null
						total: string
						status: string
					})[]
				>(
					`SELECT COUNT(*) AS purchases, COUNT(c.id) AS coupons, MAX(c.maxUses) AS maxUses,
						MAX(p.totalAmount) AS total, MAX(p.status) AS status
					 FROM AI_Purchase p JOIN AI_User u ON u.id = p.userId
					 LEFT JOIN AI_Coupon c ON c.id = p.bulkCouponId
					 WHERE u.email = ? AND p.productId = ?`,
					[email, APP_PRODUCT_ID],
				)
				expect(Number(row!.purchases)).toBe(1)
				expect(Number(row!.coupons)).toBe(1)
				expect(Number(row!.maxUses)).toBe(SEATS)

				expect(logs.map((entry) => entry.event)).toEqual([
					'team_invoice.confirm_sent',
					'team_invoice.sent',
				])
				console.info(
					JSON.stringify({
						proof: 'team-invoice-form',
						run: RUN,
						listUnitCents: LIST_CENTS,
						seats: SEATS,
						invoice: invoiceId,
						line: {
							quantity: line.quantity,
							unitAmount: line.price?.unit_amount,
							amount: line.amount,
						},
						discount: discount?.coupon
							? {
									percentOff: discount.coupon.percent_off,
									amountOff: discount.coupon.amount_off,
								}
							: null,
						subtotal: invoice.subtotal,
						total: invoice.total,
						expectedTotal,
						amountPaid: paid.amount_paid,
						purchase: {
							rows: Number(row!.purchases),
							status: row!.status,
							totalAmount: row!.total,
							bulkCouponMaxUses: Number(row!.maxUses),
						},
						newPurchaseEvent: sendEvent.mock.calls.map(([event]) => event),
						logEvents: logs,
					}),
				)
			},
			180_000,
		)
	},
)
