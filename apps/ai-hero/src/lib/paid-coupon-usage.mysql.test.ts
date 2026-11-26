import { performance } from 'node:perf_hooks'
import { eq } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { formatPricesForProduct } from '@coursebuilder/commerce/format-prices-for-product'
import { getCouponForCode } from '@coursebuilder/commerce/props-for-commerce'

import {
	AUTHORITATIVE_PRODUCT_IDS,
	C5_PRODUCT_ID,
} from '@/lib/c5-pricing/products'
import {
	couponDisplayView,
	paidCouponPricingView,
} from './paid-coupon-pricing-view'
import {
	previewPaidCouponBackfill,
	recordPaidCouponUse,
} from './paid-coupon-usage'
import { propsForCommerce } from './coupon-display'
import {
	coupon,
	merchantAccount,
	merchantCoupon,
	merchantCustomer,
	merchantPrice,
	merchantProduct,
	prices,
	products,
	purchases,
	users,
} from '@/db/schema'

const stripeSession = vi.hoisted(() =>
	vi.fn(
		async (params: {
			metadata?: Record<string, string>
			discounts?: Array<{ promotion_code: string }>
		}) => ({
			id: 'cs_coupon_test',
			url: 'https://checkout.example.test/session',
			amount_subtotal: 29_900,
			total_details: {
				amount_discount:
					new Map([
						['promo_paid-coupon-test-stripe', 10_000],
						['promo_sale_coupon_test', 5_000],
					]).get(params.discounts?.[0]?.promotion_code ?? '') ?? 0,
			},
		}),
	),
)
vi.mock('@/coursebuilder/stripe-provider', async () => {
	const { default: StripeProvider } =
		await import('@coursebuilder/commerce/stripe-provider')
	return {
		stripeProvider: StripeProvider({
			baseSuccessUrl: 'https://example.test',
			cancelUrl: 'https://example.test',
			errorRedirectUrl: 'https://example.test/error',
			paymentsAdapter: {
				getPrice: async (id: string) => ({
					id,
					product: 'prod_coupon_test',
					active: true,
					currency: 'usd',
					billing_scheme: 'per_unit',
					unit_amount: 29900,
					recurring: null,
				}),
				getCouponPercentOff: async () => 0,
				createPromotionCode: async ({ coupon }: { coupon: string }) =>
					`promo_${coupon}`,
				createCheckoutSession: stripeSession,
				expireCheckoutSession: async () => ({ status: 'expired' }),
			} as never,
		}),
	}
})
vi.mock('@/lib/c5-pricing/server', () => ({
	c5AuthoritativePrice: async () => null,
}))
vi.mock('@/server/session-access-runtime', () => ({
	bustSessionAccessForUser: vi.fn(),
}))
vi.mock('next/headers', () => ({
	headers: async () => new Headers(),
	cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: async () => ({}),
	authOptions: {},
}))
vi.mock('@/coursebuilder/email-list-provider', () => ({
	emailListProvider: { id: 'email-list', options: {} },
}))
vi.mock('@/coursebuilder/email-provider', () => ({
	emailProvider: { id: 'email', options: {} },
	magicLinkIdentity: undefined,
}))
vi.mock('@/coursebuilder/openai-provider', () => ({
	openaiProvider: { id: 'openai', options: {} },
}))
vi.mock('@/coursebuilder/transcript-provider', () => ({
	transcriptProvider: { id: 'transcript', options: {} },
}))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/buy-path/server', () => ({ emitBuyPath: vi.fn() }))
vi.mock('@/lib/products-query', () => ({ getProduct: vi.fn() }))
vi.mock('@/lib/purchase-disputes', () => ({
	isUserBlockedFromPurchasing: async () => false,
}))

// The coupon-mint CI step installs the real app schema before running this file.
const uri = process.env.AIH_COUPON_MINT_MYSQL_URL
const productId = 'product-ma254'
const merchantId = 'paid-coupon-test-merchant'
const key = (name: string) => `paid-coupon-test-${name}`

function safeTestUrl(raw: string) {
	const url = new URL(raw)
	if (
		url.protocol !== 'mysql:' ||
		url.hostname !== '127.0.0.1' ||
		!['/couponsingle_app', '/coupon_mint_test'].includes(url.pathname)
	) {
		throw new Error('requires a disposable coupon test database')
	}
	return raw
}

describe.skipIf(!uri)(
	'paid coupon usage through the app adapter and real schema',
	() => {
		let runtime: typeof import('@/db')
		let protectCommerceRequest: typeof import('@/coursebuilder/protect-commerce-request').protectCommerceRequest
		const adapter = () => runtime.courseBuilderAdapter
		const deps = {
			session: async () => ({}),
			productType: async () => 'self-paced',
		}

		beforeAll(async () => {
			vi.stubEnv('DATABASE_URL', safeTestUrl(uri!))
			runtime = await import('@/db')
			protectCommerceRequest = (
				await import('@/coursebuilder/protect-commerce-request')
			).protectCommerceRequest
			await runtime.db.insert(products).values({
				id: productId,
				name: 'Synthetic Crash Course',
				status: 1,
				type: 'self-paced',
				fields: { slug: 'synthetic-crash-course' },
			})
			await runtime.db
				.insert(prices)
				.values({ id: key('price'), productId, unitAmount: '299', status: 1 })
			await runtime.db.insert(merchantCoupon).values({
				id: merchantId,
				type: 'special',
				status: 1,
				amountDiscount: 10_000,
				identifier: key('stripe'),
				merchantAccountId: key('account'),
			})
		})

		afterAll(async () => {
			await runtime?.closeDatabasePool()
			vi.unstubAllEnvs()
		})

		const createCoupon = (
			id: string,
			options: Partial<typeof coupon.$inferInsert> = {},
		) =>
			runtime.db.insert(coupon).values({
				id,
				maxUses: 1,
				status: 1,
				merchantCouponId: merchantId,
				restrictedToProductId: productId,
				amountDiscount: 10_000,
				...options,
			})
		const createPurchase = (
			id: string,
			siteCouponId: string | null,
			options: Partial<typeof purchases.$inferInsert> = {},
		) =>
			runtime.db.insert(purchases).values({
				id,
				couponId: siteCouponId,
				productId,
				status: 'Valid',
				merchantChargeId: `charge-${id}`,
				totalAmount: '199',
				fields: { testField: 1 },
				...options,
			})
		const request = (
			path: string,
			init?: ConstructorParameters<typeof NextRequest>[1],
		) => new NextRequest(`https://example.test/api/coursebuilder${path}`, init)
		const checkout = (id: string, product = productId) =>
			request(
				`/checkout/stripe?productId=${product}&couponId=${merchantId}&usedCouponId=${id}&quantity=1&cancelUrl=https%3A%2F%2Fexample.test`,
				{ method: 'POST' },
			)
		const priceRequest = (id: string, product = productId) =>
			request('/prices-formatted', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					productId: product,
					quantity: 1,
					couponId: id,
					merchantCoupon: { id: merchantId },
				}),
			})
		const price = async (id: string) => {
			const result = await protectCommerceRequest(priceRequest(id), deps)
			const input = await result.request.json()
			return {
				...(await formatPricesForProduct({
					ctx: paidCouponPricingView(adapter()),
					productId: input.productId,
					quantity: input.quantity,
					usedCouponId: input.couponId,
					merchantCouponId: input.merchantCoupon?.id,
					autoApplyPPP: false,
				})),
				paidCouponUsedUp: result.paidCouponUsedUp,
			}
		}

		it.each(['Valid', 'Restricted'])(
			'quotes $299 with a notice and allows undiscounted checkout after a %s purchase, before accounting',
			async (status) => {
				const id = key(status)
				await createCoupon(id)
				expect(await price(id)).toMatchObject({
					calculatedPrice: 199,
					usedCouponId: id,
				})
				await createPurchase(key(`purchase-${status}`), id, { status })
				expect(await price(id)).toMatchObject({
					calculatedPrice: 299,
					paidCouponUsedUp: true,
				})
				const next = await protectCommerceRequest(checkout(id), deps)
				expect(next.request).toBeInstanceOf(NextRequest)
				const params = (next.request as NextRequest).nextUrl.searchParams
				expect(params.has('couponId')).toBe(false)
				expect(params.has('usedCouponId')).toBe(false)
				expect(
					await getCouponForCode(id, [productId], couponDisplayView(adapter())),
				).toMatchObject({
					isUsedUp: true,
					isValid: false,
					paidCouponUsedUp: true,
					merchantCouponId: merchantId,
				})
				// Testing the actual raw adapter getter matters: views must never leak onto write inputs.
				expect(await adapter().getCoupon(id)).toMatchObject({
					usedCount: 0,
					merchantCouponId: merchantId,
				})
				expect(await paidCouponPricingView(adapter()).getCoupon(id)).toBeNull()
				expect(await adapter().couponForIdOrCode({ couponId: id })).toBeNull()
			},
		)

		it('keeps the owner guard and ignores legacy coupon selectors on authoritative products', async () => {
			const id = key('authoritative')
			await createCoupon(id, { restrictedToProductId: null, usedCount: 1 })
			expect(AUTHORITATIVE_PRODUCT_IDS.has(productId)).toBe(false)
			expect(AUTHORITATIVE_PRODUCT_IDS.has(C5_PRODUCT_ID)).toBe(true)
			for (const input of [
				checkout(id, C5_PRODUCT_ID),
				priceRequest(id, C5_PRODUCT_ID),
			]) {
				const result = await protectCommerceRequest(input, {
					...deps,
					session: async () => ({ userId: 'test-buyer' }),
				})
				expect(result.paidCouponUsedUp).toBeUndefined()
				if (input.nextUrl.pathname.endsWith('/prices-formatted')) {
					expect(await result.request.json()).not.toHaveProperty('couponId')
				} else {
					expect(
						(result.request as NextRequest).nextUrl.searchParams.has(
							'usedCouponId',
						),
					).toBe(false)
				}
			}
			const result = await protectCommerceRequest(checkout(id), {
				session: async () => ({ userId: 'test-owner' }),
				productType: async () => 'cohort',
				existingPurchases: async () => [{ status: 'Valid', bulk: false }],
			})
			expect((result.request as Response).headers.get('location')).toBe(
				'https://example.test/invoices?already-own=1',
			)
		})

		it('keeps a spent coupon visible to the default Course Builder config', async () => {
			const id = key('raw-config')
			await createCoupon(id)
			await createPurchase(key('raw-config-purchase'), id)
			const { courseBuilderConfig } =
				await import('@/coursebuilder/course-builder-config')
			expect(
				await courseBuilderConfig.adapter.couponForIdOrCode({ couponId: id }),
			).toMatchObject({ id, usedCount: 0 })
			for (const method of [
				'getCoupon',
				'couponForIdOrCode',
				'getDefaultCoupon',
				'createMerchantChargeAndPurchase',
				'redeemFullPriceCoupon',
			] as const) {
				expect(courseBuilderConfig.adapter[method]).toBe(
					runtime.rawCourseBuilderAdapter[method],
				)
			}
		})

		it.each([
			{ merchantChargeId: null, totalAmount: '199' },
			{ merchantChargeId: 'synthetic-charge', totalAmount: '0' },
		])('does not account a free redemption (%j)', async (options) => {
			const id = key(`free-${options.totalAmount}`)
			await createCoupon(id)
			await createPurchase(`${id}-purchase`, id, options)
			expect(await recordPaidCouponUse(runtime.db, `${id}-purchase`)).toBe(
				'not_applicable',
			)
		})

		it('records once on concurrent replay and can count a purchase once payment settles', async () => {
			const id = key('replay')
			const first = key('first')
			const later = key('later')
			await createCoupon(id, { maxUses: 2 })
			await createPurchase(first, id)
			const record = (purchaseId: string) =>
				recordPaidCouponUse(runtime.db, purchaseId)
			expect(
				(await Promise.all([record(first), record(first)])).sort(),
			).toEqual(['already-counted', 'counted'])
			const stored = await runtime.db.query.purchases.findFirst({
				where: eq(purchases.id, first),
			})
			expect(stored?.fields).toEqual({
				testField: 1,
				paidCouponUseCounted: true,
			})
			await createPurchase(later, id, {
				status: 'Disputed',
				fields: null,
			})
			expect(await record(later)).toBe('pending')
			await runtime.db
				.update(purchases)
				.set({ status: 'Valid' })
				.where(eq(purchases.id, later))
			expect(await record(later)).toBe('counted')
			expect(await record(later)).toBe('already-counted')
			expect((await adapter().getCoupon(id))?.usedCount).toBe(2)
		})

		it('uses the real HTTP pricing handlers for Stripe session creation and preserves late fulfillment', async () => {
			const { commercePricingHandlers } =
				await import('@/coursebuilder/course-builder-config')
			const id = key('open-session')
			const sale = key('active-sale')
			const saleMerchant = key('sale-merchant')
			const account = key('account')
			const product = key('merchant-product')
			const customer = key('merchant-customer')
			const user = key('synthetic-user')
			await runtime.db.insert(merchantAccount).values({
				id: account,
				status: 1,
				label: 'stripe',
				identifier: key('stripe-account'),
			})
			await runtime.db.insert(merchantProduct).values({
				id: product,
				productId,
				merchantAccountId: account,
				status: 1,
				identifier: 'prod_coupon_test',
			})
			await runtime.db.insert(merchantPrice).values({
				id: key('merchant-price'),
				priceId: key('price'),
				merchantProductId: product,
				merchantAccountId: account,
				identifier: 'price_coupon_test',
				status: 1,
			})
			await runtime.db
				.insert(users)
				.values({ id: user, email: 'coupon-fixture@example.test' })
			await runtime.db.insert(merchantCustomer).values({
				id: customer,
				userId: user,
				merchantAccountId: account,
				identifier: 'cus_coupon_test',
			})
			await createCoupon(id, { code: key('code') })
			const open = async (input: NextRequest) => {
				const guarded = await protectCommerceRequest(input, deps)
				expect(guarded.request).toBeInstanceOf(NextRequest)
				const response = await commercePricingHandlers.POST(
					guarded.request as NextRequest,
				)
				expect(response.headers.get('location')).toBe(
					'https://checkout.example.test/session',
				)
				return stripeSession.mock.lastCall![0]
			}
			const openSession = await open(checkout(id))
			expect(openSession.metadata?.usedCouponId).toBe(id)
			await createPurchase(key('first-session-paid'), id)
			const { courseBuilderCoreFunctions } =
				await import('@coursebuilder/server')
			const { findCheckoutHandler } =
				await import('./checkout-reconcile/fulfill')
			const fulfill = findCheckoutHandler(courseBuilderCoreFunctions)
			const { magicLinkIdentity } = await vi.importActual<
				typeof import('@/coursebuilder/email-provider')
			>('@/coursebuilder/email-provider')
			expect(
				await magicLinkIdentity.couponForIdOrCode({ couponId: id }),
			).toMatchObject({ id })
			const settledSession = {
				id: 'cs_coupon_test',
				object: 'checkout.session',
				mode: 'payment',
				payment_status: 'paid',
				status: 'complete',
				amount_total: 19900,
				amount_subtotal: 29900,
				created: Math.floor(Date.now() / 1000),
				currency: 'usd',
				custom_fields: [],
				customer_details: {
					address: null,
					email: 'coupon-fixture@example.test',
					name: 'Fixture Buyer',
				},
				livemode: false,
				payment_method_collection: 'always',
				phone_number_collection: { enabled: false },
				success_url: 'https://example.test/thanks',
				subscription: null,
				total_details: {
					amount_discount: 10000,
					amount_tax: 0,
					amount_shipping: 0,
				},
				metadata: {
					...Object.fromEntries(
						Object.entries(openSession.metadata ?? {}).map(([k, v]) => [
							k,
							String(v),
						]),
					),
					userId: user,
				},
				customer: {
					id: 'cus_coupon_test',
					email: 'coupon-fixture@example.test',
					name: 'Fixture Buyer',
				},
				line_items: {
					data: [
						{
							quantity: 1,
							discounts: [],
							price: {
								product: {
									id: 'prod_coupon_test',
									name: 'Synthetic Crash Course',
								},
							},
						},
					],
				},
				payment_intent: {
					id: 'pi_coupon_open_session',
					latest_charge: { id: 'ch_coupon_open_session', amount: 19900 },
				},
			}
			const sendEvent = vi.fn(async () => undefined)
			const { purchase: latePurchase } = (await fulfill({
				event: {
					name: 'stripe/checkout-session-completed',
					data: {
						stripeEvent: {
							id: 'evt_coupon_open_session',
							created: Math.floor(Date.now() / 1000),
							type: 'checkout.session.completed',
							data: {
								object: {
									...settledSession,
									customer: 'cus_coupon_test',
									payment_intent: 'pi_coupon_open_session',
								},
							},
						},
					},
				},
				step: {
					run: async (_: string, fn: () => Promise<unknown>) => fn(),
					sendEvent,
				},
				db: magicLinkIdentity,
				paymentProvider: {
					options: {
						paymentsAdapter: { getCheckoutSession: async () => settledSession },
					},
				},
			})) as { purchase: { id: string; couponId: string } }
			expect(sendEvent).toHaveBeenCalledWith(
				'commerce/new-purchase-created',
				expect.objectContaining({
					data: expect.objectContaining({ purchaseId: latePurchase.id }),
				}),
			)
			expect(latePurchase.couponId).toBe(id)
			expect(await recordPaidCouponUse(runtime.db, latePurchase.id)).toBe(
				'counted',
			)
			await runtime.db.insert(merchantCoupon).values({
				id: saleMerchant,
				type: 'special',
				status: 1,
				amountDiscount: 5000,
				identifier: 'sale_coupon_test',
				merchantAccountId: account,
			})
			await createCoupon(sale, {
				default: true,
				merchantCouponId: saleMerchant,
				amountDiscount: 5000,
				expires: new Date(Date.now() + 86_400_000),
			})
			const buyerProps = await propsForCommerce(
				{
					query: { code: key('code') },
					products: [await adapter().getProduct(productId)].filter(
						(product) => product !== null,
					),
					userId: undefined,
				},
				adapter(),
			)
			expect(buyerProps.couponFromCode).toMatchObject({
				id,
				isValid: false,
				paidCouponUsedUp: true,
			})
			expect(buyerProps.couponIdFromCoupon).toBeUndefined()
			const quote = await protectCommerceRequest(
				request(`/prices-formatted?code=${key('code')}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ productId, quantity: 1, autoApplyPPP: false }),
				}),
				deps,
			)
			expect(quote.paidCouponUsedUp).toBe(true)
			expect(
				await (
					await commercePricingHandlers.POST(quote.request as NextRequest)
				).json(),
			).toMatchObject({
				calculatedPrice: 249,
				usedCouponId: sale,
				appliedMerchantCoupon: { id: saleMerchant },
			})
			const nextSession = await open(checkout(id))
			expect(nextSession.metadata?.usedCouponId).not.toBe(id)
			expect(nextSession.metadata?.expectedTotalCents).toBe('24900')
			expect(nextSession.discounts).toEqual([
				{ promotion_code: 'promo_sale_coupon_test' },
			])
		})

		it('strips a spent code but retains the requested team quantity', async () => {
			const id = key('quantity-two')
			await createCoupon(id)
			await createPurchase(`${id}-purchase`, id)
			const { request: guarded } = await protectCommerceRequest(
				request(
					`/checkout/stripe?productId=${productId}&quantity=2&usedCouponId=${id}&couponId=${merchantId}`,
					{ method: 'POST' },
				),
				deps,
			)
			expect(guarded).toBeInstanceOf(NextRequest)
			const params = (guarded as NextRequest).nextUrl.searchParams
			expect(params.get('quantity')).toBe('2')
			expect(params.has('usedCouponId')).toBe(false)
			expect(params.get('couponId')).not.toBe(merchantId)
		})

		it('previews only unmarked eligible purchases as grouped hashes', async () => {
			const { createHash } = await import('node:crypto')
			const id = key('preview')
			await createCoupon(id)
			await createPurchase(`${id}-marked`, id, {
				fields: { paidCouponUseCounted: true },
			})
			await createPurchase(`${id}-free`, id, { merchantChargeId: null })
			await createPurchase(`${id}-eligible`, id, { fields: null })
			const hash = createHash('sha256').update(id).digest('hex')
			const preview = await previewPaidCouponBackfill(runtime.db)
			expect(preview.find((row) => row.couponHash === hash)).toEqual({
				couponHash: hash,
				count: 1,
			})
			expect((await adapter().getCoupon(id))?.usedCount).toBe(0)
			expect(
				(
					await runtime.db.query.purchases.findFirst({
						where: eq(purchases.id, `${id}-eligible`),
					})
				)?.fields,
			).toBeNull()
		})

		it('honors the stored counter, excludes refunded rows, and leaves bulk seats alone', async () => {
			const team = key('team')
			const refund = key('refund')
			const global = key('global')
			await createCoupon(team, { maxUses: 2, usedCount: 1 })
			await createCoupon(refund)
			await createCoupon(global, { restrictedToProductId: null })
			await createPurchase(key('team-source'), null, { bulkCouponId: team })
			await createPurchase(key('team-seat'), team, {
				redeemedBulkCouponId: team,
			})
			await createPurchase(key('team-provenance-a'), team)
			await createPurchase(key('team-provenance-b'), team)
			await createPurchase(key('refund-purchase'), refund, {
				status: 'Refunded',
			})
			await createPurchase(key('global-purchase'), global)
			expect((await adapter().getCouponForDisplay(team))?.usedCount).toBe(1)
			expect((await adapter().getCouponForDisplay(refund))?.usedCount).toBe(0)
			expect((await adapter().getCouponForDisplay(global))?.usedCount).toBe(0)
			await runtime.db
				.update(coupon)
				.set({ usedCount: 1 })
				.where(eq(coupon.id, global))
			expect(await adapter().getCouponForDisplay(global)).toMatchObject({
				paidCouponUsedUp: true,
			})
			for (const id of [
				'team-source',
				'team-seat',
				'team-provenance-a',
				'refund-purchase',
			]) {
				expect(await recordPaidCouponUse(runtime.db, key(id))).toBe(
					'ineligible',
				)
			}
			expect((await adapter().getCoupon(team))?.usedCount).toBe(1)
		})

		it('does not auto-select an exhausted finite default coupon', async () => {
			const id = key('default')
			const defaultProduct = key('default-product')
			await runtime.db.insert(products).values({
				id: defaultProduct,
				name: 'Synthetic Default Offer',
				status: 1,
				type: 'self-paced',
				fields: { slug: defaultProduct },
			})
			await createCoupon(id, {
				default: true,
				restrictedToProductId: defaultProduct,
				expires: new Date(Date.now() + 86_400_000),
			})
			expect(await adapter().getDefaultCoupon([defaultProduct])).toMatchObject({
				defaultCoupon: { id },
			})
			await createPurchase(key('default-purchase'), id, {
				productId: defaultProduct,
			})
			expect(await adapter().getDefaultCoupon([defaultProduct])).toBeNull()
		})

		it('measures the display read with and without the purchase fallback', async () => {
			const id = key('timing')
			await createCoupon(id)
			await adapter().getCouponForDisplay(id)
			const time = async (read: (id: string) => Promise<unknown>) => {
				const start = performance.now()
				for (let i = 0; i < 30; i++) await read(id)
				return ((performance.now() - start) / 30).toFixed(2)
			}
			console.info('Coupon fixture mean, 30 warm reads each:', {
				rawMs: await time(adapter().getCoupon),
				availabilityMs: await time(adapter().getCouponForDisplay),
			})
		})
	},
)
