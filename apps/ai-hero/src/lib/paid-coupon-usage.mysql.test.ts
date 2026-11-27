import { performance } from 'node:perf_hooks'
import { eq, sql } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import Stripe from 'stripe'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { formatPricesForProduct } from '@coursebuilder/commerce/format-prices-for-product'
import { getCouponForCode } from '@coursebuilder/commerce/props-for-commerce'

import {
	AUTHORITATIVE_PRODUCT_IDS,
	C5_PRODUCT_ID,
} from '@/lib/c5-pricing/products'
import {
	cloneAdapter,
	couponDisplayView,
	paidCouponPricingView,
} from './paid-coupon-pricing-view'
import {
	propsForCommerce,
	getCouponForCode as appGetCouponForCode,
} from './coupon-display'
import { cohortCouponPresentation } from './coupon-batches/cohort-presentation'
import { newSelector, selectorDigest } from './coupon-batches/selector'
import {
	coupon,
	couponBatchControl,
	merchantAccount,
	merchantCharge,
	merchantCoupon,
	merchantCustomer,
	merchantPrice,
	merchantProduct,
	prices,
	products,
	purchases,
	users,
} from '@/db/schema'

const runId = crypto.randomUUID().slice(0, 8)
// The test harness supplies this fixture to the app's real webhook route.
const webhookSecret = 'test_webhook_secret'
const paymentCalls = vi.hoisted(() => vi.fn())
afterEach(() => { vi.unstubAllEnvs() })
const inngestSend = vi.hoisted(() =>
	vi.fn(async (_event: unknown) => ({ ids: [] })),
)
vi.mock('@/inngest/inngest.server', () => ({ inngest: { send: inngestSend } }))
vi.mock('@/lib/c5-pricing/gift-settlement', () => ({
	settleGiftSession: vi.fn(),
}))
const stripeSession = vi.hoisted(() =>
	vi.fn(
		async (params: {
			metadata?: Record<string, string>
			discounts?: Array<{ promotion_code: string }>
		}) => ({
			id: key('cs'),
			url: 'https://checkout.example.test/session',
			amount_subtotal: 29_900,
			total_details: {
				amount_discount: params.discounts?.[0]?.promotion_code.endsWith(
					'-regional-discount',
				)
					? 22_425
					: (new Map([
							[`promo_${key('stripe')}`, 10_000],
							[`promo_${key('sale-discount')}`, 5_000],
						]).get(params.discounts?.[0]?.promotion_code ?? '') ?? 0),
			},
		}),
	),
)
vi.mock('@/coursebuilder/stripe-provider', async () => {
	const { default: StripeProvider } =
		await import('@coursebuilder/commerce/stripe-provider')
	const stripe = new Stripe('sk_test_synthetic_paid_coupon_fixture')
	return {
		stripeProvider: StripeProvider({
			baseSuccessUrl: 'https://example.test',
			cancelUrl: 'https://example.test',
			errorRedirectUrl: 'https://example.test/error',
			paymentsAdapter: new Proxy({
				stripe,
				verifyWebhookSignature: async (body: string, signature: string) =>
					Boolean(
						stripe.webhooks.constructEvent(body, signature, webhookSecret),
					),
				getPrice: async (id: string) => ({
					id,
					product: key('stripe-product'),
					active: true,
					currency: 'usd',
					billing_scheme: 'per_unit',
					unit_amount: 29900,
					recurring: null,
				}),
				getCouponPercentOff: async (id: string) =>
					id.endsWith('-regional-discount') ? 75 : 0,
				createPromotionCode: async ({ coupon }: { coupon: string }) =>
					`promo_${coupon}`,
				createCheckoutSession: stripeSession,
				expireCheckoutSession: async () => ({ status: 'expired' }),
			}, { get(target, key) {
				const port: unknown = Reflect.get(target, key)
				return typeof port === 'function' ? (...args: unknown[]) => {
					paymentCalls(key)
					return Reflect.apply(port, target, args)
				} : port
			} }) as never,
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
vi.mock('@/server/logger', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/server/logger')>()),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/buy-path/server', () => ({ emitBuyPath: vi.fn() }))
vi.mock('@/lib/products-query', () => ({ getProduct: vi.fn() }))
vi.mock('@/lib/purchase-disputes', () => ({
	isUserBlockedFromPurchasing: async () => false,
}))

// The coupon-mint CI step installs the real app schema before running this file.
const uri = process.env.AIH_COUPON_MINT_MYSQL_URL
const key = (name: string) => `paid-coupon-test-${runId}-${name}`
const productId = key('crash-course')
const merchantId = key('merchant')

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
		let usage: typeof import('./paid-coupon-usage')
		let protectCommerceRequest: typeof import('@/coursebuilder/protect-commerce-request').protectCommerceRequest
		const adapter = () => runtime.courseBuilderAdapter
		const deps = {
			session: async () => ({}),
			productType: async () => 'self-paced',
		}

		beforeAll(async () => {
			vi.stubEnv('DATABASE_URL', safeTestUrl(uri!))
			runtime = await import('@/db')
			usage = await import('./paid-coupon-usage')
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

		it('quotes $199 when there are zero purchases for an unused code', async () => {
			const id = key('zero-purchases')
			await createCoupon(id)
			expect(await price(id)).toMatchObject({
				calculatedPrice: 199,
				usedCouponId: id,
			})
		})

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
			expect(
				await usage.recordPaidCouponUse(runtime.db, `${id}-purchase`),
			).toBe('not_applicable')
		})

		it('logs only IDs after an over-cap purchase commits, without retrying on log failure', async () => {
			const id = key('over-cap')
			const first = key('at-cap-payment')
			const second = key('over-cap-payment')
			await createCoupon(id)
			await createPurchase(first, id)
			await createPurchase(second, id)
			const { log } = await import('@/server/logger')
			const warn = vi.mocked(log.warn)
			warn.mockClear()
			const record = (purchaseId: string) =>
				usage.recordPaidCouponUse(runtime.db, purchaseId)
			expect(await record(first)).toBe('counted')
			expect(warn).not.toHaveBeenCalled()
			const committed = vi.fn()
			warn.mockImplementationOnce(async () => {
				const [row] = await runtime.db
					.select({ usedCount: coupon.usedCount })
					.from(coupon)
					.where(eq(coupon.id, id))
				const purchase = await runtime.db.query.purchases.findFirst({
					where: eq(purchases.id, second),
				})
				committed(row?.usedCount, purchase?.fields?.paidCouponUseCounted)
				throw new Error('logging unavailable')
			})
			expect(await record(second)).toBe('counted')
			expect(await record(second)).toBe('already-counted')
			expect(committed.mock.calls).toEqual([[2, true]])
			expect(warn.mock.calls).toEqual([
				['coupon_usage.over_cap', { purchaseId: second, couponId: id }],
			])
		})

		it('records once on concurrent replay and can count a purchase once payment settles', async () => {
			const id = key('replay')
			const first = key('first')
			const later = key('later')
			await createCoupon(id, { maxUses: 2 })
			await createPurchase(first, id)
			const record = (purchaseId: string) =>
				usage.recordPaidCouponUse(runtime.db, purchaseId)
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

		it('redeems a C5 bearer through the real POST wrapper and provisions a first claimant', async () => {
			vi.stubEnv('AIH_COUPON_BATCH_ENABLED', 'true')
			paymentCalls.mockClear()
			await runtime.db.insert(couponBatchControl).values({ id: 'ai-hero', claimsEnabled: 1 })
				.onDuplicateKeyUpdate({ set: { claimsEnabled: 1 } })
			const { POST } =
				await import('@/app/api/coursebuilder/[...nextCourseBuilder]/route')
			const { rawCourseBuilderAdapter } = runtime
			const { courseBuilderConfig } =
				await import('@/coursebuilder/course-builder-config')
			expect(rawCourseBuilderAdapter.createUser).not.toBe(
				courseBuilderConfig.adapter.createUser,
			)
			expect(adapter().createUser).toBe(rawCourseBuilderAdapter.createUser)
			const bearer = newSelector()
			const couponRef = `batch-coupon-${key('free-claim')}`
			await runtime.db
				.insert(products)
				.values({
					id: C5_PRODUCT_ID,
					name: 'Synthetic C5',
					status: 1,
					type: 'cohort',
					quantityAvailable: 0,
				})
				.onDuplicateKeyUpdate({ set: { quantityAvailable: 0 } })
			await runtime.db.insert(coupon).values({
				id: couponRef,
				code: selectorDigest(bearer),
				percentageDiscount: '1.00',
				restrictedToProductId: C5_PRODUCT_ID,
				status: 1,
				maxUses: 1,
				expires: new Date(Date.now() + 300000),
				fields: { couponBatchTemplate: 'c5-comp-v1', bypassSoldOut: true },
			})
			const productionAdapter = cloneAdapter(adapter())
			Object.defineProperty(productionAdapter, 'getPurchasesForUser', {
				value: productionAdapter.getPurchasesForUser,
				enumerable: false,
			})
			const previousFlag = process.env.AIH_COUPON_BATCH_ENABLED
			const presentation = (code: string) =>
				cohortCouponPresentation(
					productionAdapter,
					runtime.db,
					C5_PRODUCT_ID,
					code,
				)
			let display: typeof productionAdapter
			try {
				delete process.env.AIH_COUPON_BATCH_ENABLED
				expect(await presentation(bearer)).toBe(productionAdapter)
				process.env.AIH_COUPON_BATCH_ENABLED = 'true'
				display = await presentation(bearer)
			} finally {
				if (previousFlag === undefined)
					delete process.env.AIH_COUPON_BATCH_ENABLED
				else process.env.AIH_COUPON_BATCH_ENABLED = previousFlag
			}
			const comp = await appGetCouponForCode(bearer, [C5_PRODUCT_ID], display)
			expect(comp).toMatchObject({ isRedeemable: true })
			const c5 = await productionAdapter.getProduct(C5_PRODUCT_ID)
			if (!c5) throw new Error('missing C5 product fixture')
			const displayProps = async (userId: string) =>
				propsForCommerce(
					{
						query: { code: bearer },
						userId,
						products: [c5],
					},
					display,
				)
			expect(await displayProps(key('no-purchases'))).toMatchObject({
				couponFromCode: { id: bearer, isRedeemable: true },
				purchases: [],
			})
			const ordinary = ['off', 'on'].map((flag) =>
				key(`regular-free-coupon-${flag}`),
			)
			for (const id of ordinary)
				await createCoupon(id, {
					restrictedToProductId: C5_PRODUCT_ID,
					merchantCouponId: null,
					amountDiscount: null,
					percentageDiscount: '1.00',
				})
			const regular = await appGetCouponForCode(
				ordinary[0]!,
				[C5_PRODUCT_ID],
				display,
			)
			expect(regular).toMatchObject({ isRedeemable: true })
			const { cohortCallsToAction } =
				await import('@/app/(content)/cohorts/[slug]/_components/cohort-coming-soon')
			const closed = {
				phase: 'closed',
				productState: 'published',
				allowPurchase: false,
				hasCohortAccess: false,
				isOnWaitlist: false,
				hasActiveProduct: true,
			} as const
			expect(
				cohortCallsToAction({
					...closed,
					bypassSoldOut: regular?.fields?.bypassSoldOut === true,
				}).canEnroll,
			).toBe(false)
			expect(
				cohortCallsToAction({
					...closed,
					bypassSoldOut: comp?.fields?.bypassSoldOut === true,
				}).canEnroll,
			).toBe(true)
			const claim = (
				couponId: string,
				claimant: string,
				mediaType = 'application/json',
			) =>
				POST(
					request('/redeem/coupon', {
						method: 'POST',
						headers: { 'content-type': mediaType },
						body: JSON.stringify({
							couponId,
							email: `${key(claimant)}@example.test`,
							productIds: [C5_PRODUCT_ID],
							sendEmail: false,
						}),
					}),
				)
			for (const prefix of ['bátch-coupon-', 'ｂａｔｃｈ-coupon-']) {
				const lookalike = couponRef.replace('batch-coupon-', prefix)
				// The raw DB matches these inputs under its default collation.
				const [matched] = await runtime.db.select({ id: coupon.id }).from(coupon).where(eq(coupon.id, lookalike))
				expect(matched?.id).toBe(couponRef)
				expect(await rawCourseBuilderAdapter.getCoupon(lookalike)).toBeNull()
				expect(await rawCourseBuilderAdapter.getCouponWithBulkPurchases(lookalike)).toBeNull()
				const refused = await claim(lookalike, 'lookalike-claimant')
				expect(refused.status).toBe(200)
				expect(await refused.json()).toMatchObject({ purchase: null, error: { message: 'coupon-is-invalid' } })
			}
			expect(await rawCourseBuilderAdapter.getCoupon(couponRef)).toMatchObject({ id: couponRef, code: null, usedCount: 0 })
			let response: Response
			try {
				for (const [index, id] of ordinary.entries()) {
					if (index === 0) delete process.env.AIH_COUPON_BATCH_ENABLED
					else process.env.AIH_COUPON_BATCH_ENABLED = 'true'
					// Main's direct legacy free claim does not consult the seat cap.
					const legacy = await claim(id, `c5comp_legacy-claimant-${index}`)
					expect(legacy.status).toBe(200)
					expect(await legacy.json()).toMatchObject({
						purchase: { couponId: id, status: 'Valid' },
					})
					expect((await rawCourseBuilderAdapter.getCoupon(id))?.usedCount).toBe(
						1,
					)
				}
				response = await claim(
					bearer,
					'first-claimant',
					'application/json; charset=utf-8',
				)
			} finally {
				if (previousFlag === undefined)
					delete process.env.AIH_COUPON_BATCH_ENABLED
				else process.env.AIH_COUPON_BATCH_ENABLED = previousFlag
			}
			expect(response.status).toBe(200)
			const { purchase } = await response.json()
			expect(purchase).toMatchObject({ couponId: couponRef, status: 'Valid' })
			const organization =
				await rawCourseBuilderAdapter.getPersonalOrganization(purchase.userId)
			expect(organization).not.toBeNull()
			expect(purchase.organizationId).toBe(organization?.id)
			expect(await rawCourseBuilderAdapter.getCoupon(couponRef)).toMatchObject({
				id: couponRef,
				code: null,
				usedCount: 1,
			})
			expect(
				await rawCourseBuilderAdapter.getPurchaseWithUser(purchase.id),
			).toMatchObject({ id: purchase.id })

			const secondBearer = newSelector()
			const secondCouponRef = `batch-coupon-${key('owner-refusal')}`
			await runtime.db.insert(coupon).values({
				id: secondCouponRef, code: selectorDigest(secondBearer),
				percentageDiscount: '1.00', restrictedToProductId: C5_PRODUCT_ID,
				status: 1, maxUses: 1, expires: new Date(Date.now() + 300000),
				fields: { couponBatchTemplate: 'c5-comp-v1', bypassSoldOut: true },
			})
			for (const status of ['Valid', 'Restricted']) {
				await runtime.db.update(purchases).set({ status }).where(eq(purchases.id, purchase.id))
				const alreadyOwned = await claim(secondBearer, 'first-claimant')
				expect(alreadyOwned.status).toBe(200)
				const refusal = await alreadyOwned.text()
				expect(JSON.parse(refusal)).toEqual({
					purchase: null, redeemingForCurrentUser: true,
					error: { message: 'already-purchased-c5' },
				})
				expect(refusal).not.toContain(secondBearer)
				expect(refusal).not.toContain('@example.test')
			}
			expect(await rawCourseBuilderAdapter.getCoupon(secondCouponRef)).toMatchObject({ usedCount: 0 })
			expect(await rawCourseBuilderAdapter.getPurchasesForUser(purchase.userId)).toHaveLength(1)
			expect(paymentCalls).not.toHaveBeenCalled()
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
				identifier: key('stripe-product'),
			})
			await runtime.db.insert(merchantPrice).values({
				id: key('merchant-price'),
				priceId: key('price'),
				merchantProductId: product,
				merchantAccountId: account,
				identifier: key('stripe-price'),
				status: 1,
			})
			await runtime.db
				.insert(users)
				.values({ id: user, email: `${key('buyer')}@example.test` })
			await runtime.db.insert(merchantCustomer).values({
				id: customer,
				userId: user,
				merchantAccountId: account,
				identifier: key('stripe-customer'),
			})
			await createCoupon(id, { code: key('code') })
			const open = async (input: NextRequest, userId?: string) => {
				const guarded = await protectCommerceRequest(input, {
					...deps,
					session: async () => ({ userId }),
				})
				expect(guarded.request).toBeInstanceOf(NextRequest)
				const response = await commercePricingHandlers.POST(
					guarded.request as NextRequest,
				)
				expect(response.headers.get('location')).toBe(
					'https://checkout.example.test/session',
				)
				return stripeSession.mock.lastCall![0]
			}
			const noPaidRef = `batch-coupon-${key('paid-selector-test')}`
			const noPaidBearer = newSelector()
			// Deliberately give the reserved test row a paid merchant discount.
			// Neither the saved ID nor the code may select it on a paid path.
			await createCoupon(noPaidRef, { code: noPaidBearer })
			expect(
				await runtime.rawCourseBuilderAdapter.getCoupon(noPaidRef),
			).toMatchObject({ id: noPaidRef })
			for (const selector of [noPaidRef, noPaidBearer]) {
				const quote = await protectCommerceRequest(
					request('/prices-formatted', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							productId,
							quantity: 1,
							couponId: selector,
							code: selector,
							autoApplyPPP: false,
						}),
					}),
					deps,
				)
				expect(
					await (
						await commercePricingHandlers.POST(quote.request as NextRequest)
					).json(),
				).toMatchObject({ calculatedPrice: 299 })
				const { POST } = await import('@/app/api/coursebuilder/[...nextCourseBuilder]/route')
				const route = `/checkout/stripe?productId=${productId}&quantity=1&cancelUrl=https%3A%2F%2Fexample.test`
				const before = stripeSession.mock.calls.length
				for (const input of [
					request(`${route}&couponId=${selector}&usedCouponId=${selector}&code=${selector}`, { method: 'POST' }),
					request(route, {
						method: 'POST', headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ couponId: selector, usedCouponId: selector }),
					}),
				]) {
					const response = await POST(input)
					expect(response.status).toBe(400)
					expect(await response.text()).not.toContain(selector)
				}
				expect(stripeSession.mock.calls.length).toBe(before)
			}
			const openSession = await open(checkout(id))
			expect(openSession.metadata?.usedCouponId).toBe(id)
			await createPurchase(key('first-session-paid'), id)
			const usedCount = async (couponId: string) => {
				const [row] = await runtime.db
					.select({ used: coupon.usedCount })
					.from(coupon)
					.where(eq(coupon.id, couponId))
				return row?.used
			}
			const paidMarker = async (purchaseId: string) => {
				const [row] = await runtime.db
					.select({
						type: sql<string>`JSON_TYPE(JSON_EXTRACT(${purchases.fields}, '$.paidCouponUseCounted'))`,
						value: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.paidCouponUseCounted'))`,
					})
					.from(purchases)
					.where(eq(purchases.id, purchaseId))
				return row
			}
			expect(await usedCount(id)).toBe(0)
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
				id: key('cs'),
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
					email: `${key('buyer')}@example.test`,
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
				} as Record<string, string>,
				customer: {
					id: key('stripe-customer'),
					email: `${key('buyer')}@example.test`,
					name: 'Fixture Buyer',
				},
				line_items: {
					data: [
						{
							quantity: 1,
							discounts: [],
							price: {
								product: {
									id: key('stripe-product'),
									name: 'Synthetic Crash Course',
								},
							},
						},
					],
				},
				payment_intent: {
					id: key('stripe-payment-intent'),
					latest_charge: { id: key('stripe-charge'), amount: 19900 },
				},
			}
			const { POST } =
				await import('@/app/api/coursebuilder/[...nextCourseBuilder]/route')
			const { stripeProvider } = await import('@/coursebuilder/stripe-provider')
			const { stripe } = stripeProvider.options.paymentsAdapter as unknown as {
				stripe: Stripe
			}
			const retrieve = vi
				.spyOn(stripe.checkout.sessions, 'retrieve')
				.mockRejectedValue(new Error('unseeded fixture session'))
			const throughWebhook = async (
				session: typeof settledSession,
				suffix: string,
			) => {
				retrieve.mockResolvedValueOnce(session as never)
				inngestSend.mockClear()
				const payload = JSON.stringify({
					id: key(`stripe-event-${suffix}`),
					created: Math.floor(Date.now() / 1000),
					type: 'checkout.session.completed',
					data: {
						object: {
							...session,
							customer: session.customer.id,
							payment_intent: session.payment_intent.id,
						},
					},
				})
				const signature = stripe.webhooks.generateTestHeaderString({
					payload,
					secret: webhookSecret,
				})
				const response = await POST(
					request('/webhook/stripe', {
						method: 'POST',
						headers: {
							'stripe-signature': signature,
							'content-type': 'application/json',
						},
						body: payload,
					}),
				)
				expect(response.status).toBe(200)
				const event = inngestSend.mock.calls
					.map(([value]) => value as { name: string; data: unknown })
					.find((value) => value.name === 'stripe/checkout-session-completed')
				expect(event).toBeDefined()
				return event
			}
			const sendEvent = vi.fn(async () => undefined)
			const settle = async (session: typeof settledSession, suffix: string) =>
				(await fulfill({
					event: await throughWebhook(session, suffix),
					step: {
						run: async (_: string, fn: () => Promise<unknown>) => fn(),
						sendEvent,
					},
					db: magicLinkIdentity,
					paymentProvider: {
						options: {
							paymentsAdapter: { getCheckoutSession: async () => session },
						},
					},
				})) as { purchase: { id: string; couponId: string } }
			const { purchase: latePurchase } = await settle(settledSession, 'new')
			expect(sendEvent).toHaveBeenCalledWith(
				'commerce/new-purchase-created',
				expect.objectContaining({
					data: expect.objectContaining({ purchaseId: latePurchase.id }),
				}),
			)
			expect(latePurchase.couponId).toBe(id)
			expect(await usedCount(id)).toBe(1)
			expect(await usage.recordPaidCouponUse(runtime.db, latePurchase.id)).toBe(
				'already-counted',
			)
			expect(await usedCount(id)).toBe(1)
			expect(await usage.recordPaidCouponUse(runtime.db, latePurchase.id)).toBe(
				'already-counted',
			)
			expect(await usedCount(id)).toBe(1)
			const liveMarker = await paidMarker(latePurchase.id)
			expect(liveMarker).toEqual({ type: 'BOOLEAN', value: 'true' })

			// A purchase written before the adapter upgrade is marked by the same
			// function the desk uses for backfill. Replaying its charge on 3.3.0
			// must find the old purchase without adding a second coupon use.
			const historicalCoupon = key('backfill-coupon')
			const historicalPurchase = key('backfill-purchase')
			const historicalCharge = key('backfill-charge')
			const providerCharge = key('backfill-stripe-charge')
			await createCoupon(historicalCoupon)
			const settledCharge = await runtime.db.query.merchantCharge.findFirst({
				where: eq(
					merchantCharge.identifier,
					settledSession.payment_intent.latest_charge.id,
				),
			})
			if (!settledCharge) throw new Error('fixture charge missing')
			await runtime.db.insert(merchantCharge).values({
				id: historicalCharge,
				identifier: providerCharge,
				userId: user,
				merchantAccountId: settledCharge.merchantAccountId,
				merchantProductId: settledCharge.merchantProductId,
				merchantCustomerId: settledCharge.merchantCustomerId,
			})
			await createPurchase(historicalPurchase, historicalCoupon, {
				userId: user,
				merchantChargeId: historicalCharge,
			})
			expect(await usedCount(historicalCoupon)).toBe(0)
			expect(
				await usage.recordPaidCouponUse(runtime.db, historicalPurchase),
			).toBe('counted')
			expect(await usedCount(historicalCoupon)).toBe(1)
			expect(await paidMarker(historicalPurchase)).toEqual(liveMarker)
			const { purchase: replayed } = await settle(
				{
					...settledSession,
					id: key('backfill-session'),
					metadata: {
						...settledSession.metadata,
						usedCouponId: historicalCoupon,
					},
					payment_intent: {
						id: key('backfill-payment-intent'),
						latest_charge: { id: providerCharge, amount: 19900 },
					},
				},
				'backfill-replay',
			)
			expect(replayed.id).toBe(historicalPurchase)
			expect(
				await usage.recordPaidCouponUse(runtime.db, historicalPurchase),
			).toBe('already-counted')
			expect(await usedCount(historicalCoupon)).toBe(1)
			expect(await paidMarker(historicalPurchase)).toEqual(liveMarker)
			const pppId = key('regional-merchant')
			const regionalBuyer = key('regional-buyer')
			await runtime.db
				.insert(users)
				.values({ id: regionalBuyer, email: `${regionalBuyer}@example.test` })
			await runtime.db.insert(merchantCustomer).values({
				id: key('regional-customer'),
				userId: regionalBuyer,
				merchantAccountId: account,
				identifier: key('regional-provider-customer'),
			})
			await runtime.db.insert(merchantCoupon).values({
				id: pppId,
				merchantAccountId: account,
				identifier: key('regional-discount'),
				type: 'ppp',
				status: 1,
				percentageDiscount: '0.75',
			})
			for (const userId of [undefined, regionalBuyer]) {
				const headers = {
					'x-vercel-ip-country': 'IN',
					'content-type': 'application/json',
				}
				const quote = await protectCommerceRequest(
					request('/prices-formatted', {
						method: 'POST',
						headers,
						body: JSON.stringify({
							productId,
							quantity: 1,
							couponId: id,
							merchantCoupon: { id: pppId },
							autoApplyPPP: false,
						}),
					}),
					{ ...deps, session: async () => ({ userId }) },
				)
				expect(quote.paidCouponUsedUp).toBe(true)
				expect(
					await (
						await commercePricingHandlers.POST(quote.request as NextRequest)
					).json(),
				).toMatchObject({
					calculatedPrice: 74.75,
					appliedMerchantCoupon: { type: 'ppp' },
				})
				const session = await open(
					request(
						`/checkout/stripe?productId=${productId}&quantity=1&couponId=${pppId}&usedCouponId=${id}&country=US&cancelUrl=https%3A%2F%2Fexample.test`,
						{ method: 'POST', headers },
					),
					userId,
				)
				expect(session.metadata?.expectedTotalCents).toBe('7475')
				expect(session.metadata?.usedCouponId).not.toBe(id)
			}
			await runtime.db.insert(merchantCoupon).values({
				id: saleMerchant,
				type: 'special',
				status: 1,
				amountDiscount: 5000,
				identifier: key('sale-discount'),
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
						(product): product is NonNullable<typeof product> =>
							product !== null,
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
				{ promotion_code: `promo_${key('sale-discount')}` },
			])

			// A signed legacy session might already carry metadata. Preserve the
			// paid purchase without ever associating or counting the comp row.
			for (const [i, prefix] of ['batch-coupon-', 'bátch-coupon-', 'ｂａｔｃｈ-coupon-'].entries()) {
				const alias = noPaidRef.replace('batch-coupon-', prefix)
				expect(await runtime.rawCourseBuilderAdapter.couponForIdOrCode({ couponId: alias })).toBeNull()
				const paid = await runtime.rawCourseBuilderAdapter.createMerchantChargeAndPurchase({
					userId: user,
					productId,
					merchantAccountId: account,
					merchantProductId: product,
					merchantCustomerId: customer,
					stripeChargeId: key(`charge-reserved-metadata-${i}`),
					checkoutSessionId: key(`session-reserved-metadata-${i}`),
					stripeChargeAmount: 29_900,
					usedCouponId: alias,
					upgradedFromPurchaseId: undefined,
					appliedPPPStripeCouponId: undefined,
				})
				expect(paid.couponId).toBeNull()
			}
			expect(await usedCount(noPaidRef)).toBe(0)
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
			const preview = await usage.previewPaidCouponBackfill(runtime.db)
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

		it('classifies deploy and backfill flips without exposing the underlying rows', async () => {
			const original = await usage.previewPaidCouponFlips(runtime.db)
			const evergreen = key('flip-evergreen')
			await createCoupon(evergreen, {
				restrictedToProductId: 'product-ma254',
				fields: { evergreenOffer: {} },
			})
			await createPurchase(`${evergreen}-purchase`, evergreen, {
				productId: 'product-ma254',
			})
			const credit = key('flip-credit')
			const creditMerchant = key('flip-credit-merchant')
			await runtime.db.insert(merchantCoupon).values({
				id: creditMerchant,
				type: 'special credit',
				status: 1,
				amountDiscount: 10000,
				merchantAccountId: key('account'),
			})
			await createCoupon(credit, { merchantCouponId: creditMerchant })
			await createPurchase(`${credit}-purchase`, credit)
			const other = key('flip-other')
			await createCoupon(other, { restrictedToProductId: null })
			await createPurchase(`${other}-purchase`, other)
			const summary = await usage.previewPaidCouponFlips(runtime.db)
			expect(summary).toEqual({
				atDeploy: {
					...original.atDeploy,
					evergreenMa254: original.atDeploy.evergreenMa254 + 1,
					creditSource: original.atDeploy.creditSource + 1,
				},
				additionalAfterBackfill: {
					...original.additionalAfterBackfill,
					other: original.additionalAfterBackfill.other + 1,
				},
			})
		})

		it('writes an archive policy to an existing JSON-null Purchase.fields', async () => {
			const id = key('archive-purchase')
			await runtime.db.insert(purchases).values({
				id,
				productId,
				status: 'Valid',
				totalAmount: '199',
				fields: sql`CAST('null' AS JSON)`,
			})
			const [before] = await runtime.db
				.select({ kind: sql<string>`JSON_TYPE(${purchases.fields})` })
				.from(purchases)
				.where(eq(purchases.id, id))
			expect(before?.kind).toBe('NULL')
			const { persistArchivePolicySnapshot } =
				await import('@/lib/archive-products')
			const policy = { availableAfterDays: 15, accessDurationDays: 365 }
			await persistArchivePolicySnapshot({ purchaseId: id, policy })
			expect(
				(
					await runtime.db.query.purchases.findFirst({
						where: eq(purchases.id, id),
					})
				)?.fields,
			).toEqual({ archivePolicy: policy })
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
				expect(await usage.recordPaidCouponUse(runtime.db, key(id))).toBe(
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
