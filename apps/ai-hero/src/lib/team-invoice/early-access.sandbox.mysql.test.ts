import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { mysqlTable } from '@/db/mysql-table'
import * as schema from '@/db/schema'
import { validateMySqlIntegrationServerUrl } from '@/lib/team-purchase-mysql-test-guard'
import { eq, or, sql } from 'drizzle-orm'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'
import Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'
import { StripePaymentAdapter } from '@coursebuilder/commerce/stripe-provider'
import { courseBuilderCoreFunctions } from '@coursebuilder/server'
import {
	AUTOMATIC_ACCESS,
	grantEarlyAccess,
	type EarlyAccessPorts,
} from './early-access'
import { createEarlyAccessPurchase } from './early-access-purchase'
import { createAndSendTeamInvoice } from './stripe-team-invoice'

// Same disposable schema / real adapter / real sandbox handler as OL-094.
// No production env pull; absent credentials skip, a non-test key fails closed.
const KEY = process.env.AIH_STRIPE_SANDBOX_KEY ?? ''
const SERVER = process.env.AIH_TEST_MYSQL_SERVER_URL ?? ''
if (KEY && !/^(sk|rk)_test_/.test(KEY))
	throw new Error('Refusing a non-test Stripe key')
const RUN = `early-access-${randomUUID()}`
const RIG = { rig: 'aihero-commerce', rig_run: RUN }
const PRODUCT = 'early-access-sandbox-product'
const stripe = KEY
	? new Stripe(KEY, { apiVersion: '2024-06-20' as Stripe.LatestApiVersion })
	: null!
const handler = courseBuilderCoreFunctions.find(
	(fn) => fn.config.id === 'stripe-invoice-payment-succeeded',
)!.handler as (input: any) => Promise<any>
const { generateMySQLDrizzleJson, generateMySQLMigration } = createRequire(
	import.meta.url,
)('drizzle-kit/api') as typeof import('drizzle-kit/api')
const tables = Object.fromEntries(
	[
		'users',
		'roles',
		'userRoles',
		'merchantAccount',
		'merchantProduct',
		'merchantCustomer',
		'merchantCharge',
		'merchantSession',
		'merchantCoupon',
		'merchantPrice',
		'coupon',
		'purchases',
		'purchaseUserTransfer',
		'products',
		'prices',
		'upgradableProducts',
		'contentResource',
		'contentResourceProduct',
		'contentResourceResource',
	].map((name) => [name, schema[name as keyof typeof schema]]),
)

describe.skipIf(!KEY || !SERVER)(
	'early access sandbox Stripe + disposable MySQL',
	() => {
		let server: Pool,
			pool: Pool,
			name: string,
			database: MySqlDatabase<any, any, typeof schema>
		let adapter: ReturnType<typeof DrizzleAdapter>,
			stripeProduct: string,
			price: string
		const invoices: string[] = [],
			customers: string[] = []
		const notify = vi.fn(async () => {})
		let ports: EarlyAccessPorts
		beforeAll(async () => {
			const safe = validateMySqlIntegrationServerUrl(SERVER, {
				nodeEnv: process.env.NODE_ENV,
				vercelEnv: process.env.VERCEL_ENV,
			})
			if (safe.port === '3307') throw new Error('Refusing shared database 3307')
			server = mysql.createPool({ uri: safe.toString(), timezone: 'Z' })
			name = `aih_early_${randomUUID().replaceAll('-', '')}`
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
			for (const statement of await generateMySQLMigration(
				await generateMySQLDrizzleJson({}),
				await generateMySQLDrizzleJson(tables),
			))
				await pool.query(statement)
			database = drizzle(pool, {
				schema,
				mode: 'planetscale',
			}) as unknown as typeof database
			adapter = DrizzleAdapter(database, mysqlTable)
			stripeProduct = (
				await stripe.products.create({
					name: `Early access synthetic ${RUN}`,
					metadata: RIG,
				})
			).id
			price = (
				await stripe.prices.create({
					product: stripeProduct,
					currency: 'usd',
					unit_amount: 19900,
					metadata: RIG,
				})
			).id
			await pool.query(
				"INSERT INTO AI_MerchantAccount (id, status, label, identifier) VALUES ('ma_early', 1, 'stripe', 'acct_early')",
			)
			await pool.query(
				"INSERT INTO AI_Product (id, name, type, status, fields) VALUES (?, 'Synthetic Early Access', 'self-paced', 1, JSON_OBJECT('slug', 'early-access'))",
				[PRODUCT],
			)
			await pool.query(
				"INSERT INTO AI_MerchantProduct (id, merchantAccountId, productId, status, identifier) VALUES ('mp_early', 'ma_early', ?, 1, ?)",
				[PRODUCT, stripeProduct],
			)
			ports = {
				invoice: (id) => stripe.invoices.retrieve(id),
				mark: (id, metadata) => stripe.invoices.update(id, { metadata }),
				purchases: async (id) =>
					(
						await database
							.select({ p: schema.purchases })
							.from(schema.purchases)
							.leftJoin(
								schema.merchantSession,
								eq(
									schema.merchantSession.id,
									schema.purchases.merchantSessionId,
								),
							)
							.where(
								or(
									eq(schema.merchantSession.identifier, id),
									sql`JSON_UNQUOTE(JSON_EXTRACT(${schema.purchases.fields}, '$.invoiceId')) = ${id}`,
								),
							)
					).map((row) => row.p),
				create: (invoice, at) =>
					createEarlyAccessPurchase(database, invoice, at),
				notify,
				lock: async (_id, work) => work(),
				revoke: async () => {},
			}
		}, 60_000)
		afterAll(async () => {
			for (const id of invoices) {
				const invoice = await stripe.invoices.retrieve(id)
				if (invoice.status === 'open') await stripe.invoices.voidInvoice(id)
			}
			for (const id of customers) await stripe.customers.del(id)
			if (price) await stripe.prices.update(price, { active: false })
			if (stripeProduct)
				await stripe.products.update(stripeProduct, { active: false })
			await pool?.end()
			if (server && name) await server.query(`DROP DATABASE \`${name}\``)
			await server?.end()
		}, 60_000)

		async function invoice(quantity: number) {
			const created = await createAndSendTeamInvoice(stripe, {
				orderKey: `${RUN}-${randomUUID()}`,
				billingEmail: `team-${randomUUID()}@example.test`,
				companyName: 'Synthetic Early Access',
				due: { kind: 'days', days: 30 },
				stripePriceId: price,
				stripeProductId: stripeProduct,
				quantity,
				discount: { kind: 'none' },
				expectedTotal: quantity * 19900,
				metadata: {
					...RIG,
					app: 'ai-hero',
					productId: PRODUCT,
					seats: String(quantity),
					accessProvisioning: AUTOMATIC_ACCESS,
				},
			})
			invoices.push(created.invoiceId)
			customers.push(created.customerId)
			return created
		}
		async function pay(id: string, customer: string) {
			const method = await stripe.paymentMethods.attach('pm_card_visa', {
				customer,
			})
			await stripe.invoices.pay(id, { payment_method: method.id })
			let event: Stripe.Event | undefined
			await vi.waitFor(
				async () => {
					event = (
						await stripe.events.list({
							type: 'invoice.payment_succeeded',
							limit: 30,
						})
					).data.find((e) => (e.data.object as Stripe.Invoice).id === id)
					expect(event).toBeDefined()
				},
				{ timeout: 30_000, interval: 1000 },
			)
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
							stripeWebhookSecret: 'whsec_unused',
						}),
					},
				},
				notificationProvider: undefined,
			})
			return { result, sendEvent }
		}
		it.each([1, 5])(
			'grants %i seats, replay is one purchase, later real payment skips',
			async (quantity) => {
				const created = await invoice(quantity)
				const result = await grantEarlyAccess(ports, created.invoiceId, true)
				expect(result.state).toBe('granted')
				expect(
					(await grantEarlyAccess(ports, created.invoiceId, true)).state,
				).toBe('already_granted')
				const linked = await ports.purchases(created.invoiceId)
				expect(linked).toHaveLength(1)
				const purchase = await adapter.getPurchase(linked[0]!.id)
				expect(purchase?.merchantChargeId).toBeNull()
				expect(purchase?.fields?.earlyAccess).toBe(true)
				expect(purchase?.totalAmount).toBe(0)
				if (quantity > 1) {
					const coupon = await database.query.coupon.findFirst({
						where: eq(schema.coupon.id, purchase!.bulkCouponId!),
					})
					expect(coupon?.maxUses).toBe(quantity)
				} else expect(purchase?.bulkCouponId).toBeNull()
				const paid = await pay(created.invoiceId, created.customerId)
				expect(paid.result).toEqual({
					skipped: true,
					reason: 'manual-access-provisioning',
				})
				expect(paid.sendEvent).not.toHaveBeenCalled()
				expect(await ports.purchases(created.invoiceId)).toHaveLength(1)
				const [[counts]] = await pool.query<(RowDataPacket & { n: number })[]>(
					'SELECT COUNT(*) AS n FROM AI_MerchantCharge',
				)
				expect(Number(counts!.n)).toBe(0)
				console.info(
					JSON.stringify({
						proof: 'early-access-grant-replay-pay',
						run: RUN,
						invoiceId: created.invoiceId,
						quantity,
						purchaseId: purchase!.id,
						purchases: 1,
						merchantCharges: 0,
					}),
				)
			},
			90_000,
		)
		it('refuses a paid automatic invoice without creating an early-access purchase', async () => {
			const created = await invoice(1)
			await pay(created.invoiceId, created.customerId)
			await expect(
				grantEarlyAccess(ports, created.invoiceId, true),
			).rejects.toThrow(/only an unpaid OPEN|already has a purchase/)
			expect(
				(await ports.purchases(created.invoiceId)).filter(
					(p) => p.fields?.earlyAccess,
				),
			).toHaveLength(0)
		}, 90_000)
	},
)
