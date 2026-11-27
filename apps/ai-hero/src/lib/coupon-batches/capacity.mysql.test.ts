import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import * as schema from '@/db/schema'
import { teamSaleState } from '@/lib/team-invoice/sale-state'
import { PRODUCT, ROW_PREFIX, TEMPLATE } from './namespace'

vi.mock('next/cache', async (original) => ({
	...(await original<typeof import('next/cache')>()),
	unstable_cache: (fn: unknown) => fn,
}))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/server/auth', () => ({ getServerAuthSession: async () => ({}) }))
// The fixture's default coupon drives the OG sale, not the cohort price.
vi.mock('@/lib/default-coupon', () => ({ getCachedDefaultCoupon: async () => null }))
vi.mock('@/lib/c5-pricing/server', () => ({
	c5AuthoritativePrice: async () => null,
	frontDeskData: () => null,
}))
vi.mock('@/app/api/front-desk/hooks', () => ({ hooks: {} }))
vi.mock('@/server/session-access-runtime', () => ({
	bustSessionAccessForUser: vi.fn(),
}))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))
vi.mock('next/og', () => ({ ImageResponse: class extends Response {} }))
vi.mock('@/coursebuilder/stripe-provider', () => ({
	stripeProvider: {
		id: 'stripe',
		options: {
			paymentsAdapter: {
				stripe: {
					prices: {
						retrieve: async () => ({
							active: true,
							currency: 'usd',
							type: 'one_time',
							unit_amount: 29900,
						}),
					},
					invoices: { search: () => ({ autoPagingToArray: async () => [] }) },
				},
			},
		},
	},
}))

const mysqlUrl = process.env.AIH_COUPON_BATCH_MYSQL_URL
const run = randomUUID().slice(0, 8)
const key = (value: string) => `capacity-${run}-${value}`
const cap = 8
const compIds = [0, 1].map((i) => `${ROW_PREFIX}${key(`comp-${i}`)}`)
const team = key('team')
const sale = key('sale')
const account = key('account')
const merchant = key('merchant')
const price = key('price')
const providerPrice = key('provider-price')
const cohort = key('cohort')
const user = key('user')
const seat = (
	label: string,
	values: Pick<typeof schema.purchases.$inferInsert, 'totalAmount'> &
		Partial<typeof schema.purchases.$inferInsert>,
) => ({
	id: key(label),
	productId: PRODUCT,
	userId: user,
	status: 'Valid' as const,
	...values,
})
const fixtures = [
	seat('paid', { totalAmount: '299', merchantChargeId: key('charge') }),
	seat('discounted', { totalAmount: '1', couponId: compIds[0] }),
	seat('settled-zero', {
		totalAmount: '0',
		couponId: compIds[1],
		merchantChargeId: key('charged-zero'),
	}),
	seat('ordinary-free', { totalAmount: '0', couponId: sale }),
	seat('team-parent', { totalAmount: '598', bulkCouponId: team }),
	seat('team-seat', {
		totalAmount: '0',
		redeemedBulkCouponId: team,
		couponId: compIds[0],
	}),
	...compIds.map((couponId, i) =>
		seat(`comp-${i}`, { totalAmount: '0', couponId }),
	),
]

describe.skipIf(!mysqlUrl)('C5 cap reads with the production queries', () => {
	let runtime: typeof import('@/db')
	let seededProduct = false
	beforeAll(async () => {
		const url = new URL(mysqlUrl!)
		if (
			url.protocol !== 'mysql:' ||
			url.hostname !== '127.0.0.1' ||
			!/^\/coupon_batch_fixture(?:_[a-z0-9]+)?$/.test(url.pathname)
		)
			throw new Error('unsafe capacity fixture database')
		vi.stubEnv('DATABASE_URL', url.toString())
		runtime = await import('@/db')
		const { db } = runtime
		await db
			.insert(schema.products)
			.values({
				id: PRODUCT,
				type: 'cohort',
				name: 'Synthetic C5 capacity',
				quantityAvailable: cap,
				status: 1,
				fields: { state: 'published', slug: cohort },
			})
		seededProduct = true
		await db
			.insert(schema.users)
			.values({ id: user, email: `${user}@example.test` })
		await db
			.insert(schema.contentResource)
			.values({
				id: cohort,
				type: 'cohort',
				createdById: user,
				fields: { title: 'Synthetic C5 capacity', slug: cohort },
			})
		await db
			.insert(schema.contentResourceProduct)
			.values({ productId: PRODUCT, resourceId: cohort })
		await db
			.insert(schema.prices)
			.values({ id: price, productId: PRODUCT, unitAmount: '299', status: 1 })
		await db
			.insert(schema.merchantAccount)
			.values({
				id: account,
				label: 'stripe',
				status: 1,
				identifier: key('stripe-account'),
			})
		await db
			.insert(schema.merchantProduct)
			.values({
				id: merchant,
				productId: PRODUCT,
				merchantAccountId: account,
				identifier: key('stripe-product'),
				status: 1,
			})
		await db
			.insert(schema.merchantPrice)
			.values({
				id: providerPrice,
				priceId: price,
				merchantProductId: merchant,
				merchantAccountId: account,
				identifier: key('stripe-price'),
				status: 1,
			})
		await db
			.insert(schema.coupon)
			.values([
				...compIds.map((id) => ({
					id,
					restrictedToProductId: PRODUCT,
					maxUses: 1,
					percentageDiscount: '1.00',
					status: 1,
					fields: { couponBatchTemplate: TEMPLATE },
				})),
				{ id: team, maxUses: 2, status: 1 },
				{
					id: sale,
					default: true,
					restrictedToProductId: PRODUCT,
					maxUses: -1,
					status: 1,
					percentageDiscount: '0.20',
					expires: new Date(Date.now() + 600_000),
				},
			])
		await db.insert(schema.purchases).values(fixtures)
	})

	afterAll(async () => {
		try {
			if (seededProduct) {
				const { db } = runtime
				await db.delete(schema.purchases).where(
					inArray(
						schema.purchases.id,
						fixtures.map(({ id }) => id),
					),
				)
				await db
					.delete(schema.coupon)
					.where(inArray(schema.coupon.id, [...compIds, team, sale]))
				await db
					.delete(schema.merchantPrice)
					.where(eq(schema.merchantPrice.id, providerPrice))
				await db
					.delete(schema.merchantProduct)
					.where(eq(schema.merchantProduct.id, merchant))
				await db
					.delete(schema.merchantAccount)
					.where(eq(schema.merchantAccount.id, account))
				await db.delete(schema.prices).where(eq(schema.prices.id, price))
				await db
					.delete(schema.contentResourceProduct)
					.where(eq(schema.contentResourceProduct.resourceId, cohort))
				await db
					.delete(schema.contentResource)
					.where(eq(schema.contentResource.id, cohort))
				await db.delete(schema.users).where(eq(schema.users.id, user))
				await db.delete(schema.products).where(eq(schema.products.id, PRODUCT))
			}
		} finally {
			await runtime?.closeDatabasePool()
			vi.unstubAllEnvs()
		}
	})

	it('removes only the two template comps from every existing cap reader and restores the legacy counts when stopped', async () => {
		const { loadCohortPageData } = await import('@/lib/cohorts-query')
		const { getPricingData } = await import('@/lib/pricing-query')
		const { GET: availability } =
			await import('@/app/api/(content)/products/[productId]/availability/route')
		const { integration } = await import('@/app/api/support/integration')
		if (!integration.getProductStatus) throw new Error('missing support cap reader')
		const { loadProduct } =
			await import('@/lib/team-invoice/team-invoice-server')
		const { GET: saleImage } = await import('@/app/api/og/default/route')
		vi.stubEnv('AIH_COUPON_BATCH_ENABLED', '')
		for (const enabled of [false, true, false]) {
			if (enabled) process.env.AIH_COUPON_BATCH_ENABLED = 'true'
			else delete process.env.AIH_COUPON_BATCH_ENABLED
			const remaining = enabled ? 2 : 0
			const page = await loadCohortPageData(cohort, {})
			expect(page).toMatchObject({
				quantityAvailable: remaining,
				purchaseCount: cap - remaining,
			})
			expect(await page.pricingDataLoader).toMatchObject({
				quantityAvailable: remaining,
			})
			expect(await getPricingData({ productId: PRODUCT })).toMatchObject({
				quantityAvailable: remaining,
				formattedPrice: { calculatedPrice: 299 },
			})
			const response = await availability(
				new NextRequest(
					`https://example.test/api/products/${PRODUCT}/availability`,
				),
				{ params: Promise.resolve({ productId: PRODUCT }) },
			)
			expect(await response.json()).toEqual({
				quantityAvailable: remaining,
				unlimited: false,
			})
			expect(await integration.getProductStatus(PRODUCT)).toMatchObject({
				quantityRemaining: remaining,
				soldOut: !enabled,
				available: enabled,
			})
			const invoice = await loadProduct(PRODUCT)
			expect(invoice?.purchaseCount).toBe(cap - remaining)
			expect(
				teamSaleState(invoice!.product, {
					now: new Date(),
					purchaseCount: invoice!.purchaseCount,
					seats: 2,
				}).onSale,
			).toBe(enabled)
			const image = await saleImage(
				new Request('https://example.test/api/og/default'),
			)
			expect(image.status).toBe(200)
			const maxAge = Number(
				/s-maxage=(\d+)/.exec(image.headers.get('cache-control') ?? '')?.[1],
			)
			if (enabled) {
				expect(maxAge).toBeGreaterThanOrEqual(60)
				expect(maxAge).toBeLessThanOrEqual(600)
			} else expect(maxAge).toBe(3600)
		}
	})
})
