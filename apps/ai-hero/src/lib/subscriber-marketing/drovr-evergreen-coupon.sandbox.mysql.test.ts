import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { protectCourseBuilderRequest } from '@/coursebuilder/coursebuilder-request-authorization'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { mysqlTable } from '@/db/mysql-table'
import * as schema from '@/db/schema'
import { validateMySqlIntegrationServerUrl } from '@/lib/team-purchase-mysql-test-guard'
import { eq } from 'drizzle-orm'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import { NextRequest } from 'next/server'
import Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'
import type { CommerceAdapter } from '@coursebuilder/commerce'
import { stripeCheckoutResult } from '@coursebuilder/commerce/stripe-checkout'
import { StripePaymentAdapter } from '@coursebuilder/commerce/stripe-provider'

import type { SideEffectIntent } from './types'
import {
	createDrovrEvergreenClaimApplication,
	drovrClaimVerifiedOwnerReader,
	resolveDrovrClaim,
	type DrovrClaimReaders,
} from './drovr-evergreen-claim'
import {
	executePendingEvergreenCoupons,
	ISSUE_EVERGREEN_COUPON_INTENT_TYPE,
	type CouponIssuerRepository,
} from './drovr-evergreen-coupon'
import { findEvergreenMerchantEvidence } from './evergreen-merchant-evidence'
import { createCouponAuthority } from './evergreen-offer-journey/coupon-authority'
import {
	couponCommerceSchema,
	createMySqlCouponCommerceStore,
} from './evergreen-offer-journey/coupon-authority-mysql'
import {
	EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
	EVERGREEN_OFFER_MAX_USES,
	EVERGREEN_OFFER_PRODUCT_ID,
} from './evergreen-offer-journey/domain'

/**
 * An evergreen coupon from issue to a Stripe sandbox Checkout Session: the
 * drovr coupon executor issues it through the real coupon authority and its
 * MySQL store, the claim binds it to its verified owner, and Course Builder
 * checkout prices it behind the real request guard with the real Stripe
 * payments adapter. Checkout's own verifier refuses a session whose Stripe
 * total differs from the app's expected total. Only the pending-intent
 * repository is in memory. This file imports no Effect, so the same test
 * runs on either Effect major. Skipped unless both are set:
 *
 *   AIH_TEST_MYSQL_SERVER_URL=$(scripts/test-mysql.sh up | cut -d= -f2-) \
 *   AIH_STRIPE_SANDBOX_KEY=sk_test_... \
 *     pnpm vitest run src/lib/subscriber-marketing/drovr-evergreen-coupon.sandbox.mysql.test.ts
 *
 * Refuses a live key and the shared 3307 database. Every sandbox object
 * carries `rig=aihero-commerce` and a `rig_run`.
 */

const KEY = process.env.AIH_STRIPE_SANDBOX_KEY ?? ''
const SERVER_URL = process.env.AIH_TEST_MYSQL_SERVER_URL ?? ''
const isTestKey = /^(sk|rk)_test_/.test(KEY)
const RUN = `evergreen-coupon-${randomUUID()}`
const RIG = { rig: 'aihero-commerce', rig_run: RUN }
const LIST_CENTS = 29_900
const CONTACT_ID = 'evergreen-proof-contact'
const OWNER = { id: 'user_eg_owner', email: 'evergreen-owner@example.test' }
const SHARER = { id: 'user_eg_sharer', email: 'evergreen-sharer@example.test' }
const HOUR = 60 * 60 * 1000

const { generateMySQLDrizzleJson, generateMySQLMigration } = createRequire(
	import.meta.url,
)('drizzle-kit/api') as typeof import('drizzle-kit/api')

// Checkout, the request guard and the coupon authority read these.
const tables = {
	users: schema.users,
	roles: schema.roles,
	userRoles: schema.userRoles,
	contact: schema.contact,
	merchantAccount: schema.merchantAccount,
	merchantProduct: schema.merchantProduct,
	merchantPrice: schema.merchantPrice,
	merchantCustomer: schema.merchantCustomer,
	merchantCharge: schema.merchantCharge,
	merchantSession: schema.merchantSession,
	merchantCoupon: schema.merchantCoupon,
	coupon: schema.coupon,
	purchases: schema.purchases,
	purchaseUserTransfer: schema.purchaseUserTransfer,
	products: schema.products,
	prices: schema.prices,
	upgradableProducts: schema.upgradableProducts,
	contentResource: schema.contentResource,
	contentResourceProduct: schema.contentResourceProduct,
	contentResourceResource: schema.contentResourceResource,
	entitlements: schema.entitlements,
	entitlementTypes: schema.entitlementTypes,
}

type Database = MySqlDatabase<any, any, typeof schema>

/** The real adapter, with rig metadata on everything checkout creates. */
class RiggedStripePaymentAdapter extends StripePaymentAdapter {
	sessions: Stripe.Checkout.Session[] = []
	coupons: string[] = []
	override async createCheckoutSession(
		...[params, options]: Parameters<StripePaymentAdapter['createCheckoutSession']>
	) {
		const session = await super.createCheckoutSession(
			{ ...params, metadata: { ...params.metadata, ...RIG } },
			options,
		)
		this.sessions.push(session)
		return session
	}
	override async createCoupon(
		...[params, options]: Parameters<StripePaymentAdapter['createCoupon']>
	) {
		const id = await super.createCoupon(
			{ ...params, metadata: { ...params.metadata, ...RIG } },
			options,
		)
		this.coupons.push(id)
		return id
	}
	override createPromotionCode(
		...[params, options]: Parameters<StripePaymentAdapter['createPromotionCode']>
	) {
		return super.createPromotionCode(
			{ ...params, metadata: { ...params.metadata, ...RIG } },
			options,
		)
	}
	override createCustomer(
		...[params, options]: Parameters<StripePaymentAdapter['createCustomer']>
	) {
		return super.createCustomer(
			{ ...params, metadata: { ...params.metadata, ...RIG } },
			options,
		)
	}
}

const stripe = isTestKey
	? new Stripe(KEY, { apiVersion: '2024-06-20' as Stripe.LatestApiVersion })
	: (null as unknown as Stripe)

describe.skipIf(!isTestKey || !SERVER_URL)(
	'evergreen coupon issue, claim and checkout, sandbox Stripe + disposable database',
	() => {
		let server: Pool
		let pool: Pool
		let plain: Pool
		let name: string
		let adapter: CommerceAdapter
		let payments: RiggedStripePaymentAdapter
		let couponId = ''
		const ids = {} as Record<'product' | 'price' | 'merchantCoupon', string>
		const intents: SideEffectIntent[] = []
		const now = new Date()
		const issueAt = new Date(now.getTime() - HOUR).toISOString()
		const expiresAt = new Date(now.getTime() + 72 * HOUR).toISOString()

		const repository: CouponIssuerRepository = {
			findContactById: async (id) =>
				id === CONTACT_ID ? ({ id, email: OWNER.email } as never) : undefined,
			findPendingSideEffectIntentsByType: async (type, limit) =>
				intents
					.filter((row) => row.type === type && row.status === 'pending')
					.slice(0, limit),
			updateSideEffectIntent: async (id, update) => {
				const index = intents.findIndex((row) => row.id === id)
				intents[index] = { ...intents[index]!, ...update } as SideEffectIntent
				return intents[index]!
			},
		}
		const authority = async () =>
			createCouponAuthority({
				store: createMySqlCouponCommerceStore(
					drizzle(plain, { schema: couponCommerceSchema, mode: 'default' }),
				),
				merchantCouponEvidence: await findEvergreenMerchantEvidence(
					drizzle(pool, { schema, mode: 'planetscale' }) as never,
				),
				readVerifiedOwner: drovrClaimVerifiedOwnerReader(() =>
					new Date().toISOString(),
				),
				now: () => new Date().toISOString(),
			})
		const stable = (value: unknown) =>
			JSON.parse(
				Object.entries({ ...ids, issueAt, expiresAt })
					.reduce(
						(json, [key, id]) => json.replaceAll(id, `<${key}>`),
						JSON.stringify(value),
					)
					// MySQL keeps milliseconds; ISO instants and Date JSON agree.
					.replaceAll(issueAt.replace(/\.\d{3}Z$/, ''), '<issueAt>')
					.replaceAll(expiresAt.replace(/\.\d{3}Z$/, ''), '<expiresAt>')
					// Any other instant is an observation time from this run.
					.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<instant>'),
			)

		/** The checkout route: the request guard, then Course Builder. */
		const checkout = async (
			verifiedUserId: string,
			query: Record<string, string>,
		) => {
			const url = new URL('https://app.test/api/coursebuilder/checkout/stripe')
			for (const [key, value] of Object.entries({
				productId: EVERGREEN_OFFER_PRODUCT_ID,
				quantity: '1',
				...query,
			}))
				url.searchParams.set(key, value)
			const guarded = await protectCourseBuilderRequest(
				new NextRequest(url, {
					method: 'POST',
					headers: { 'x-vercel-ip-country': 'US' },
				}),
				{ adapter: adapter as never, verifiedUserId },
			)
			const params = Object.fromEntries(guarded.nextUrl.searchParams)
			const before = payments.sessions.length
			const result = await stripeCheckoutResult({
				params: params as never,
				config: {
					baseSuccessUrl: 'https://app.test',
					cancelUrl: 'https://app.test/cancel',
					errorRedirectUrl: 'https://app.test/error',
					paymentsAdapter: payments,
				},
				adapter,
				requestOptions: { trustedCountry: 'US' },
			})
			const session = payments.sessions[before]
			return {
				guarded: {
					couponId: params.couponId ?? null,
					usedCouponId: params.usedCouponId ?? null,
				},
				ok: 'redirect' in result && Boolean(result.redirect),
				session: session && {
					amount_subtotal: session.amount_subtotal,
					amount_total: session.amount_total,
					amount_discount: session.total_details?.amount_discount ?? null,
					// The API returns the applied discounts; this SDK's type omits them.
					discounts:
						(session as { discounts?: unknown[] }).discounts?.length ?? 0,
				},
			}
		}

		beforeAll(async () => {
			const safe = validateMySqlIntegrationServerUrl(SERVER_URL, {
				nodeEnv: process.env.NODE_ENV,
				vercelEnv: process.env.VERCEL_ENV,
			})
			if (safe.port === '3307')
				throw new Error('refusing the shared 3307 database')
			server = mysql.createPool({ uri: safe.toString(), timezone: 'Z' })
			name = `aih_evergreen_coupon_${randomUUID().replaceAll('-', '')}`
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
			plain = mysql.createPool({
				uri: target.toString(),
				timezone: 'Z',
				connectionLimit: 4,
			})
			const statements = await generateMySQLMigration(
				await generateMySQLDrizzleJson({}),
				await generateMySQLDrizzleJson(tables),
			)
			for (const statement of statements) await pool.query(statement)
			adapter = DrizzleAdapter<Database>(
				drizzle(pool, { schema, mode: 'planetscale' }) as unknown as Database,
				mysqlTable,
			) as unknown as CommerceAdapter
			payments = new RiggedStripePaymentAdapter({
				stripeToken: KEY,
				stripeWebhookSecret: 'whsec_sandbox_unused',
			})

			// The provider side: a Crash Course product and price, and the
			// special $100.00 coupon the evergreen merchant coupon points at.
			const product = await stripe.products.create({
				name: 'Evergreen Proof Crash Course',
				metadata: RIG,
			})
			const price = await stripe.prices.create({
				product: product.id,
				unit_amount: LIST_CENTS,
				currency: 'usd',
				metadata: RIG,
			})
			const coupon = await stripe.coupons.create({
				amount_off: EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
				currency: 'usd',
				duration: 'once',
				name: 'Evergreen proof $100',
				metadata: RIG,
			})
			ids.product = product.id
			ids.price = price.id
			ids.merchantCoupon = coupon.id

			const q = (sql: string, values: unknown[] = []) => pool.query(sql, values)
			await q(
				"INSERT INTO AI_MerchantAccount (id, status, label, identifier) VALUES ('ma_eg', 1, 'stripe', 'acct_eg')",
			)
			for (const user of [OWNER, SHARER])
				await q(
					'INSERT INTO AI_User (id, email, name, emailVerified) VALUES (?, ?, ?, ?)',
					[user.id, user.email, 'Evergreen Proof', new Date('2026-01-01T00:00:00Z')],
				)
			await q(
				"INSERT INTO AI_Contact (id, email, lifecycle, isProvisional) VALUES (?, ?, 'subscriber', false)",
				[CONTACT_ID, OWNER.email],
			)
			await q(
				"INSERT INTO AI_Product (id, name, type, status, quantityAvailable, fields) VALUES (?, 'Crash Course', 'self-paced', 1, -1, JSON_OBJECT('slug', 'ai-coding-crash-course'))",
				[EVERGREEN_OFFER_PRODUCT_ID],
			)
			await q(
				"INSERT INTO AI_Price (id, status, productId, unitAmount, fields) VALUES ('price_eg_cc', 1, ?, ?, JSON_OBJECT())",
				[EVERGREEN_OFFER_PRODUCT_ID, (LIST_CENTS / 100).toFixed(2)],
			)
			await q(
				"INSERT INTO AI_MerchantProduct (id, merchantAccountId, productId, status, identifier) VALUES ('mp_eg_cc', 'ma_eg', ?, 1, ?)",
				[EVERGREEN_OFFER_PRODUCT_ID, product.id],
			)
			await q(
				"INSERT INTO AI_MerchantPrice (id, merchantAccountId, merchantProductId, status, identifier, priceId) VALUES ('mprice_eg_cc', 'ma_eg', 'mp_eg_cc', 1, ?, 'price_eg_cc')",
				[price.id],
			)
			await q(
				"INSERT INTO AI_MerchantCoupon (id, identifier, status, merchantAccountId, amountDiscount, type) VALUES ('mc_eg_special', ?, 1, 'ma_eg', ?, 'special')",
				[coupon.id, EVERGREEN_OFFER_AMOUNT_OFF_CENTS],
			)
			// Production seeds the credit entitlement type; the bind requires it.
			await q(
				"INSERT INTO AI_EntitlementType (id, name, description) VALUES ('et_special_credit', 'apply_special_credit', 'Apply a special credit coupon')",
			)
			intents.push({
				id: 'intent_eg_issue',
				type: ISSUE_EVERGREEN_COUPON_INTENT_TYPE,
				status: 'pending',
				contactId: CONTACT_ID,
				gates: [],
				reviewReasons: [],
				completedAt: null,
				metadata: {
					offer: {
						productId: EVERGREEN_OFFER_PRODUCT_ID,
						amountOffCents: EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
						maxUses: EVERGREEN_OFFER_MAX_USES,
						exclusive: true,
						regularPriceCents: LIST_CENTS,
						effectivePriceCents: LIST_CENTS - EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
						issueAt,
						expiresAt,
						timezone: 'America/Los_Angeles',
						timezoneSource: 'vercel-header',
					},
				},
			} as unknown as SideEffectIntent)
		}, 180_000)

		afterAll(async () => {
			for (const session of payments?.sessions ?? [])
				await stripe.checkout.sessions.expire(session.id).catch(() => {})
			for (const id of [ids.merchantCoupon, ...(payments?.coupons ?? [])])
				if (id) await stripe.coupons.del(id).catch(() => {})
			if (ids.product)
				await stripe.products.update(ids.product, { active: false }).catch(() => {})
			await plain?.end()
			await pool?.end()
			if (server && name) await server.query(`DROP DATABASE \`${name}\``)
			await server?.end()
		})

		it('the executor issues the coupon through the coupon authority', async () => {
			const results = await executePendingEvergreenCoupons({
				repository,
				authority: await authority(),
				writeFields: async () => {
					throw new Error('no Kit identity, so no field write')
				},
				origin: 'https://app.test',
				limit: 10,
				dispatch: () => {},
			})
			expect(results).toHaveLength(1)
			expect(results[0]).toMatchObject({ status: 'completed' })
			couponId = (results[0] as { couponId: string }).couponId
			const [rows] = await plain.query(
				'SELECT id, status, maxUses, usedCount, amountDiscount, percentageDiscount, merchantCouponId, restrictedToProductId, expires, fields FROM AI_Coupon WHERE id = ?',
				[couponId],
			)
			const row = (rows as Record<string, unknown>[])[0]!
			expect(row).toMatchObject({
				status: 1,
				maxUses: 1,
				usedCount: 0,
				merchantCouponId: 'mc_eg_special',
				restrictedToProductId: EVERGREEN_OFFER_PRODUCT_ID,
			})
			// A rerun drains nothing: the intent is completed, not pending.
			expect(
				await executePendingEvergreenCoupons({
					repository,
					authority: await authority(),
					writeFields: async () => {},
					origin: 'https://app.test',
					limit: 10,
					dispatch: () => {},
				}),
			).toEqual([])
			expect(
				stable({
					result: results[0],
					intent: {
						status: intents[0]!.status,
						metadata: {
							...intents[0]!.metadata,
							completedAt: '<now>',
							issuedAt: '<now>',
						},
					},
					row,
				}),
			).toMatchSnapshot()
		}, 60_000)

		it('a shared coupon link prices $100 off in a sandbox Checkout Session', async () => {
			const shared = await checkout(SHARER.id, {
				couponId: 'mc_eg_special',
				usedCouponId: couponId,
			})
			expect(shared.ok).toBe(true)
			expect(shared.session).toEqual({
				amount_subtotal: LIST_CENTS,
				amount_total: LIST_CENTS - EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
				amount_discount: EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
				discounts: 1,
			})
			expect(stable(shared)).toMatchSnapshot()
		}, 60_000)

		it('the claim binds the coupon to its verified owner, who checks out with it', async () => {
			// The production claim readers, on the disposable database.
			const commerce = drizzle(plain, {
				schema: couponCommerceSchema,
				mode: 'default',
			})
			const readers: DrovrClaimReaders = {
				userById: async (id) =>
					(
						await commerce
							.select({
								id: schema.users.id,
								email: schema.users.email,
								emailVerified: schema.users.emailVerified,
							})
							.from(schema.users)
							.where(eq(schema.users.id, id))
							.limit(1)
					)[0],
				contactByEmail: async (email) =>
					email === OWNER.email ? { id: CONTACT_ID, email } : undefined,
				couponById: async (id) =>
					(
						await commerce
							.select()
							.from(schema.coupon)
							.where(eq(schema.coupon.id, id))
							.limit(1)
					)[0],
			}
			const bindFailures: string[] = []
			const claims = createDrovrEvergreenClaimApplication({
				readers,
				resolveAuthority: authority,
				now: () => new Date().toISOString(),
				onBindFailure: (reason) => bindFailures.push(reason),
			})
			const session = (userId: string) => ({ userId, sessionToken: 'sandbox' })
			expect(
				await resolveDrovrClaim({
					readers,
					session: session(OWNER.id),
					now: () => new Date().toISOString(),
				}),
			).toMatchObject({ status: 'ready', couponId })
			const statuses = {
				before: await claims.status(session(OWNER.id)),
				claim: await claims.claim(session(OWNER.id)),
				again: await claims.claim(session(OWNER.id)),
				otherUser: await claims.claim(session(SHARER.id)),
			}
			expect({ ...statuses, bindFailures }).toEqual({
				bindFailures: [],
				before: 'ready',
				claim: 'bound',
				again: 'bound',
				otherUser: 'unavailable',
			})
			const [entitlements] = await plain.query(
				'SELECT e.userId, e.sourceType, e.sourceId, t.name, e.deletedAt FROM AI_Entitlement e JOIN AI_EntitlementType t ON t.id = e.entitlementType',
			)
			expect(entitlements).toEqual([
				{
					userId: OWNER.id,
					sourceType: 'COUPON',
					sourceId: couponId,
					name: 'apply_special_credit',
					deletedAt: null,
				},
			])
			const owner = await checkout(OWNER.id, { couponId: 'mc_eg_special' })
			expect(owner.ok).toBe(true)
			expect(owner.session).toMatchObject({
				amount_subtotal: LIST_CENTS,
				amount_total: LIST_CENTS - EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
			})
			expect(stable({ statuses, entitlements, owner })).toMatchSnapshot()
		}, 90_000)
	},
)
