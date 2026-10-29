import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import * as schema from '@/db/schema'
import { mysqlTable } from '@/db/mysql-table'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { guardLegendGiftCouponPaths } from '@/lib/legend-gift-coupon-guard'

import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'

// Minting and redemption run for real against MySQL; only Stripe is a stub,
// and a 100% mint must never touch it.
const state = vi.hoisted(() => ({ database: undefined as unknown }))
vi.mock('@/db', () => ({
	get db() {
		return state.database
	},
}))

import {
	listMintedCoupons,
	mintCoupons,
	type CouponMintDeps,
} from './coupon-mint'
import { drizzleCouponMintStore } from './coupon-mint-drizzle'
import { isMysqlDuplicateEntryError } from './mysql-primary-key-retry'

// A database prepared by `scripts/test-mysql.sh schema <db>`.
const uri = process.env.AIH_COUPON_MINT_MYSQL_URL
const suite = uri ? describe : describe.skip

function assertLoopbackTestDatabase(raw: string): string {
	const url = new URL(raw)
	if (
		url.protocol !== 'mysql:' ||
		!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
		['', '/mysql', '/sys'].includes(url.pathname)
	) {
		throw new Error('unsafe-coupon-mint-mysql-test-url')
	}
	return raw
}

const run = randomUUID().slice(0, 8)
const product = `product-c5-${run}`
const label = `friends-${run}`
const actor = { userId: `admin-${run}`, authMethod: 'device-token' }
const stripe = vi.fn(async (): Promise<string | null> => {
	throw new Error('Stripe forbidden')
})
const deps: CouponMintDeps = {
	store: drizzleCouponMintStore,
	createOrFindMerchantCoupon: stripe,
	isDuplicateEntryError: isMysqlDuplicateEntryError,
	idSecret: 'synthetic-id-secret',
	inviteUrl: (id) => `https://example.test?code=${id}`,
}

suite('coupon minting against real MySQL', () => {
	let pool: Pool
	let db: MySqlDatabase<any, any, typeof schema>
	let adapter: ReturnType<typeof guardLegendGiftCouponPaths>

	beforeAll(async () => {
		pool = preserveQueryResultShape(
			mysql.createPool({
				uri: assertLoopbackTestDatabase(uri!),
				connectionLimit: 4,
				timezone: 'Z',
			}),
		)
		db = drizzle(pool, { schema, mode: 'planetscale' }) as any
		state.database = db
		adapter = guardLegendGiftCouponPaths(
			DrizzleAdapter<MySqlDatabase<any, any, any>>(db, mysqlTable),
		)
		await db.insert(schema.products).values({
			id: product,
			name: 'Synthetic C5',
			type: 'cohort',
			quantityAvailable: -1,
			status: 1,
			fields: { slug: `synthetic-c5-${run}`, state: 'published' },
		})
	})

	afterAll(async () => {
		await pool?.end()
	})

	it('mints the free batch shape once, even when the same key races', async () => {
		const request = {
			productId: product,
			percentageDiscount: 1,
			quantity: 2,
			label,
		}
		const idempotencyKey = `race-${run}-0000000000`
		const [a, b] = await Promise.all([
			mintCoupons({ actor, idempotencyKey, request }, deps),
			mintCoupons({ actor, idempotencyKey, request }, deps),
		])
		if (!('coupons' in a) || !('coupons' in b)) throw new Error('mint failed')
		expect([a.state, b.state].sort()).toEqual(['minted', 'replayed'])
		expect(b.coupons).toEqual(a.coupons)
		const replay = await mintCoupons({ actor, idempotencyKey, request }, deps)
		expect(replay).toMatchObject({ state: 'replayed', coupons: a.coupons })
		expect(stripe).not.toHaveBeenCalled()

		const rows = await db.query.coupon.findMany({
			where: inArray(
				schema.coupon.id,
				a.coupons.map((c) => c.id),
			),
		})
		expect(rows).toHaveLength(2)
		for (const row of rows)
			expect(row).toMatchObject({
				restrictedToProductId: product,
				percentageDiscount: '1.00',
				maxUses: 1,
				usedCount: 0,
				merchantCouponId: null,
				status: 1,
				default: false,
				code: null,
				expires: null,
				organizationId: null,
				fields: {
					bypassSoldOut: true,
					mintedFor: label,
					mintKey: expect.stringMatching(/^[0-9a-f]{64}$/),
					mintRequest: expect.stringMatching(/^[0-9a-f]{64}$/),
				},
			})
		expect(rows.map((row) => row.fields?.mintIndex).sort()).toEqual([0, 1])

		// A smaller quantity on the same key must not replay a prefix.
		expect(
			await mintCoupons(
				{ actor, idempotencyKey, request: { ...request, quantity: 1 } },
				deps,
			),
		).toMatchObject({ state: 'conflict' })
		// Rotating the id secret still finds the stored batch through mintKey.
		expect(
			await mintCoupons(
				{ actor, idempotencyKey, request },
				{ ...deps, idSecret: 'synthetic-rotated-secret' },
			),
		).toMatchObject({ state: 'replayed', coupons: a.coupons })
	})

	it('redeems a minted 100% coupon through redeemFullPriceCoupon, once', async () => {
		const minted = await mintCoupons(
			{
				actor,
				idempotencyKey: `redeem-${run}-0000000000`,
				request: { productId: product, percentageDiscount: 1, label },
			},
			deps,
		)
		if (!('coupons' in minted)) throw new Error('mint failed')
		const couponId = minted.coupons[0]!.id
		const redeem = (email: string) =>
			adapter.redeemFullPriceCoupon({
				couponId,
				email,
				productIds: [product],
				redeemingProductId: product,
			})

		const result = await redeem(`friend-${run}@example.test`)
		expect(result?.purchase).toMatchObject({
			productId: product,
			couponId,
			redeemedBulkCouponId: null,
			status: 'Valid',
		})
		expect(Number(result!.purchase!.totalAmount)).toBe(0)
		const row = await db.query.coupon.findFirst({
			where: eq(schema.coupon.id, couponId),
		})
		expect(row?.usedCount).toBe(1)
		// maxUses 1: a second person cannot reuse the code.
		expect(await redeem(`stranger-${run}@example.test`)).toBeNull()

		const listed = await listMintedCoupons(
			{ productId: product, label },
			{ store: drizzleCouponMintStore, inviteUrl: deps.inviteUrl },
		)
		expect(listed.totals).toMatchObject({ coupons: 3, unused: 2, usedUp: 1 })
	})
})
