import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { mysqlTable } from '@/db/mysql-table'
import * as schema from '@/db/schema'
import { validateMySqlIntegrationServerUrl } from '@/lib/team-purchase-mysql-test-guard'
import { eq } from 'drizzle-orm'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'
import Stripe from 'stripe'
import { Redis } from '@upstash/redis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'
import { StripePaymentAdapter } from '@coursebuilder/commerce/stripe-provider'
import { processStripeWebhook } from '@coursebuilder/commerce/process-stripe-webhook'
import { courseBuilderCoreFunctions } from '@coursebuilder/server'
import {
	AUTOMATIC_ACCESS,
	EARLY_ACCESS,
	grantEarlyAccess,
	revokeEarlyAccess,
	type EarlyAccessPorts,
} from './early-access'
import { createEarlyAccessPorts } from './early-access-ports'
import { reconcileEarlyAccessInvoicePayment } from './early-access-payment'
import { createAndSendTeamInvoice } from './stripe-team-invoice'

// Only the helper's unused default handle is replaced. Every SQL operation
// receives the real disposable database through the same factory as production.
vi.mock('@/db', () => ({ db: {} }))

const KEY = process.env.AIH_STRIPE_SANDBOX_KEY ?? ''
const SERVER = process.env.AIH_TEST_MYSQL_SERVER_URL ?? ''
const REDIS_URL = process.env.AIH_TEST_REDIS_REST_URL
const REDIS_TOKEN = process.env.AIH_TEST_REDIS_REST_TOKEN
const redis =
	REDIS_URL && REDIS_TOKEN
		? new Redis({ url: REDIS_URL, token: REDIS_TOKEN })
		: null!
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
		'merchantEvents',
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

describe.skipIf(!KEY || !SERVER || !redis)(
	'production early access ports, sandbox Stripe + disposable MySQL',
	() => {
		let server: Pool,
			pool: Pool,
			name: string,
			database: MySqlDatabase<any, any, typeof schema>
		let adapter: ReturnType<typeof DrizzleAdapter>,
			stripeProduct: string,
			price: string,
			ports: EarlyAccessPorts
		const invoices: string[] = [],
			customers = new Set<string>()
		const send = vi.fn(async () => ({ ids: ['sandbox-event'] }))
		const paymentLog = { error: vi.fn(async () => {}) }
		const identity = vi.fn(async (email: string) =>
			adapter.findOrCreateUser(email),
		)
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
			ports = createEarlyAccessPorts({
				database,
				adapter,
				stripe,
				findUser: identity,
				redis,
				send,
			})
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

		async function invoice(
			quantity: number,
			billingEmail = `team-${randomUUID()}@example.test`,
		) {
			const created = await createAndSendTeamInvoice(stripe, {
				orderKey: `${RUN}-${randomUUID()}`,
				billingEmail,
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
			customers.add(created.customerId)
			return created
		}
		async function stripeEvent(
			type: 'invoice.payment_succeeded' | 'charge.refunded',
			id: string,
		) {
			let event: Stripe.Event | undefined
			await vi.waitFor(
				async () => {
					event = (await stripe.events.list({ type, limit: 100 })).data.find(
						(e) => (e.data.object as { id: string }).id === id,
					)
					expect(event).toBeDefined()
				},
				{ timeout: 30_000, interval: 1000 },
			)
			return event!
		}
		async function reconcile(id: string) {
			return reconcileEarlyAccessInvoicePayment(
				{ database, ports, log: paymentLog },
				id,
			)
		}
		async function pay(id: string, customer: string) {
			const method = await stripe.paymentMethods.attach('pm_card_visa', {
				customer,
			})
			await stripe.paymentMethods.update(method.id, { metadata: RIG })
			await stripe.invoices.pay(id, { payment_method: method.id })
			const event = await stripeEvent('invoice.payment_succeeded', id)
			await reconcile(id)
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
			'grants %i seats through production ports, replays, and links the real payment without a second purchase',
			async (quantity) => {
				const created = await invoice(quantity)
				// The paid path prefers the current expanded customer over billing snapshot.
				const currentEmail = `current-${randomUUID()}@example.test`
				await stripe.customers.update(created.customerId, {
					email: currentEmail,
				})
				const result = await grantEarlyAccess(ports, created.invoiceId, true)
				expect(result.state).toBe('granted')
				expect(identity).toHaveBeenCalledWith(currentEmail)
				expect(
					(await grantEarlyAccess(ports, created.invoiceId, true)).state,
				).toBe('already_granted')
				const linked = await ports.purchases(created.invoiceId)
				expect(linked).toHaveLength(1)
				const purchase = await adapter.getPurchase(linked[0]!.id)
				expect(purchase?.merchantChargeId).toBeNull()
				expect(purchase?.totalAmount).toBe(0)
				expect((await adapter.getUserById(purchase!.userId!))?.email).toBe(
					currentEmail,
				)
				expect(result.notified[0]?.earlyAccessNotifiedAt).toBeTruthy()
				if (quantity > 1)
					expect(
						(
							await database.query.coupon.findFirst({
								where: eq(schema.coupon.id, purchase!.bulkCouponId!),
							})
						)?.maxUses,
					).toBe(quantity)
				else expect(purchase?.bulkCouponId).toBeNull()
				const paid = await pay(created.invoiceId, created.customerId)
				expect(paid.result).toEqual({
					skipped: true,
					reason: 'manual-access-provisioning',
				})
				expect(paid.sendEvent).not.toHaveBeenCalled()
				await reconcile(created.invoiceId)
				expect(await ports.purchases(created.invoiceId)).toHaveLength(1)
				const after = await adapter.getPurchase(purchase!.id)
				expect(after?.merchantChargeId).toBeTruthy()
				expect(after?.totalAmount).toBe(quantity * 199)
				expect(after?.fields?.earlyAccessPaidAt).toBeTruthy()
				const [[counts]] = await pool.query<(RowDataPacket & { n: number })[]>(
					'SELECT COUNT(*) AS n FROM AI_MerchantCharge WHERE id = ?',
					[after!.merchantChargeId],
				)
				expect(Number(counts!.n)).toBe(1)
				if (quantity === 1) {
					const { user: recipient } = await adapter.findOrCreateUser(
						`recipient-${randomUUID()}@example.test`,
					)
					await database
						.update(schema.purchases)
						.set({ userId: recipient.id })
						.where(eq(schema.purchases.id, purchase!.id))
					await reconcile(created.invoiceId)
					expect((await adapter.getPurchase(purchase!.id))?.userId).toBe(
						recipient.id,
					)
					expect(
						(await adapter.getMerchantCharge(after!.merchantChargeId!))?.userId,
					).toBe(purchase!.userId)
				}
				console.info(
					JSON.stringify({
						proof: 'production-ports-grant-replay-pay',
						run: RUN,
						invoiceId: created.invoiceId,
						quantity,
						purchaseId: after!.id,
						purchases: 1,
						merchantCharges: 1,
					}),
				)
			},
			90_000,
		)
		it('normal full refund finds the linked grant and emits the normal refund/Discord removal event', async () => {
			const created = await invoice(1)
			await grantEarlyAccess(ports, created.invoiceId, true)
			await pay(created.invoiceId, created.customerId)
			const before = (await ports.purchases(created.invoiceId))[0]!
			const paidInvoice = await ports.invoice(created.invoiceId)
			const chargeId =
				typeof paidInvoice.charge === 'string'
					? paidInvoice.charge
					: paidInvoice.charge!.id
			await stripe.refunds.create({ charge: chargeId, metadata: RIG })
			const event = await stripeEvent('charge.refunded', chargeId)
			const sent = vi.fn(async () => ({ ids: [] }))
			await processStripeWebhook(event, {
				adapter,
				provider: { options: { paymentsAdapter: {} } },
				inngest: { send: sent },
			} as any)
			expect((await adapter.getPurchase(before.id))?.status).toBe('Refunded')
			expect(sent).toHaveBeenCalledWith({
				name: 'commerce/update-purchase-status',
				data: { stripeChargeId: chargeId, status: 'Refunded' },
			})
			expect((await reconcile(created.invoiceId)).state).toBe(
				'paid_already_refunded',
			)
			expect((await adapter.getPurchase(before.id))?.status).toBe('Refunded')
			expect(await ports.purchases(created.invoiceId)).toHaveLength(1)
			console.info(
				JSON.stringify({
					proof: 'grant-pay-normal-refund',
					run: RUN,
					invoiceId: created.invoiceId,
					purchaseId: before.id,
					status: 'Refunded',
					event: 'commerce/update-purchase-status',
				}),
			)
		}, 90_000)
		it('recovers exactly one Valid purchase when grant creation failed after marking and payment later lands', async () => {
			const created = await invoice(1)
			await expect(
				grantEarlyAccess(
					{
						...ports,
						create: async () => {
							throw new Error('forced infrastructure failure')
						},
					},
					created.invoiceId,
					true,
				),
			).rejects.toThrow('forced infrastructure failure')
			expect(
				(await ports.invoice(created.invoiceId)).metadata?.accessProvisioning,
			).toBe(EARLY_ACCESS)
			expect(await ports.purchases(created.invoiceId)).toHaveLength(0)
			await pay(created.invoiceId, created.customerId)
			const after = await ports.purchases(created.invoiceId)
			expect(after).toHaveLength(1)
			expect(after[0]?.status).toBe('Valid')
			expect(after[0]?.merchantChargeId).toBeTruthy()
			expect(paymentLog.error).toHaveBeenCalledWith(
				'invoice.early_access.paid_without_grant',
				{ invoiceId: created.invoiceId },
			)
		}, 90_000)
		it('real Redis lease refuses a concurrent grant while the first holds the invoice, then replay returns that purchase', async () => {
			const created = await invoice(2)
			let entered!: () => void, release!: () => void
			const started = new Promise<void>((resolve) => {
					entered = resolve
				}),
				gate = new Promise<void>((resolve) => {
					release = resolve
				})
			const first = grantEarlyAccess(
				{
					...ports,
					create: async (...args) => {
						entered()
						await gate
						return ports.create(...args)
					},
				},
				created.invoiceId,
				true,
			)
			await started
			try {
				await expect(
					grantEarlyAccess(ports, created.invoiceId, true),
				).rejects.toThrow('Another early-access operation')
			} finally {
				release()
			}
			expect((await first).state).toBe('granted')
			expect(
				(await grantEarlyAccess(ports, created.invoiceId, true)).state,
			).toBe('already_granted')
			expect(await ports.purchases(created.invoiceId)).toHaveLength(1)
			console.info(
				JSON.stringify({
					proof: 'real-redis-concurrent-grants',
					run: RUN,
					invoiceId: created.invoiceId,
					purchases: 1,
				}),
			)
		}, 90_000)
		it('refuses an already-paid automatic invoice, and can discover its paid-path purchase', async () => {
			const created = await invoice(1)
			await pay(created.invoiceId, created.customerId)
			expect(await ports.purchases(created.invoiceId)).toHaveLength(1)
			await expect(
				grantEarlyAccess(ports, created.invoiceId, true),
			).rejects.toThrow(/only an unpaid OPEN|already has a purchase/)
			expect(
				(await ports.purchases(created.invoiceId)).filter(
					(p) => p.fields?.earlyAccess,
				),
			).toHaveLength(0)
		}, 90_000)
		it('alerts instead of regranting a revoked invoice that is later paid', async () => {
			const created = await invoice(1)
			await grantEarlyAccess(ports, created.invoiceId, true)
			await revokeEarlyAccess(ports, created.invoiceId, true)
			await pay(created.invoiceId, created.customerId)
			const after = await ports.purchases(created.invoiceId)
			expect(after).toHaveLength(1)
			expect(after[0]?.status).toBe('Refunded')
			expect(after[0]?.merchantChargeId).toBeNull()
			expect(paymentLog.error).toHaveBeenCalledWith(
				'invoice.early_access.paid_after_revoke',
				{ invoiceId: created.invoiceId, purchaseId: after[0]!.id },
			)
		}, 90_000)
		it('dry run refuses unconfigured product and malformed benefits before marking', async () => {
			const created = await invoice(1)
			await database
				.update(schema.merchantProduct)
				.set({ identifier: 'prod_unconfigured' })
				.where(eq(schema.merchantProduct.id, 'mp_early'))
			try {
				await expect(
					grantEarlyAccess(ports, created.invoiceId),
				).rejects.toThrow('not configured')
			} finally {
				await database
					.update(schema.merchantProduct)
					.set({ identifier: stripeProduct })
					.where(eq(schema.merchantProduct.id, 'mp_early'))
			}
			expect(
				(await ports.invoice(created.invoiceId)).metadata?.accessProvisioning,
			).toBe(AUTOMATIC_ACCESS)
			await stripe.invoices.update(created.invoiceId, {
				metadata: { purchaseBenefits: 'not-valid-transport' },
			})
			await expect(grantEarlyAccess(ports, created.invoiceId)).rejects.toThrow(
				'benefits need review',
			)
			expect(
				(await ports.invoice(created.invoiceId)).metadata?.accessProvisioning,
			).toBe(AUTOMATIC_ACCESS)
		}, 90_000)
		it('refuses an existing Valid same-product purchase before marking', async () => {
			const email = `existing-${randomUUID()}@example.test`
			const { user } = await adapter.findOrCreateUser(email)
			await adapter.createPurchase({
				userId: user.id,
				productId: PRODUCT,
				status: 'Valid',
				totalAmount: '199.00',
			})
			const created = await invoice(1, email)
			await expect(grantEarlyAccess(ports, created.invoiceId)).rejects.toThrow(
				'already holds a Valid purchase',
			)
			expect(
				(await ports.invoice(created.invoiceId)).metadata?.accessProvisioning,
			).toBe(AUTOMATIC_ACCESS)
		}, 90_000)
	},
)
