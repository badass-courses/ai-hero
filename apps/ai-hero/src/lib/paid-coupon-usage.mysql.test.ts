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
import { recordPaidCouponUse } from './paid-coupon-usage'
import {
	coupon,
	merchantCoupon,
	prices,
	products,
	purchases,
} from '@/db/schema'

vi.mock('@/coursebuilder/stripe-provider', () => ({
	stripeProvider: undefined,
}))
vi.mock('@/lib/c5-pricing/server', () => ({
	c5AuthoritativePrice: async () => null,
}))
vi.mock('@/server/session-access-runtime', () => ({
	bustSessionAccessForUser: vi.fn(),
}))
vi.mock('@/server/auth', () => ({ getServerAuthSession: vi.fn() }))
vi.mock('@/server/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }))
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
			await runtime.db
				.insert(products)
				.values({
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
				`/checkout/stripe?productId=${product}&couponId=${merchantId}&usedCouponId=${id}`,
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
				merchantChargeId: null,
				totalAmount: '0',
				fields: null,
			})
			expect(await record(later)).toBe('pending')
			await runtime.db
				.update(purchases)
				.set({ merchantChargeId: key('charge-later'), totalAmount: '199' })
				.where(eq(purchases.id, later))
			expect(await record(later)).toBe('counted')
			expect(await record(later)).toBe('already-counted')
			expect((await adapter().getCoupon(id))?.usedCount).toBe(2)
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
