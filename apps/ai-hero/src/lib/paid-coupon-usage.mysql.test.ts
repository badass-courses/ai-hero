import type { DbExecutor } from '@/db/client'
import { NextRequest } from 'next/server'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { CommerceAdapter } from '@coursebuilder/commerce'
import { formatPricesForProduct } from '@coursebuilder/commerce/format-prices-for-product'
import { getCouponForCode } from '@coursebuilder/commerce/props-for-commerce'
import { couponSchema } from '@coursebuilder/core/schemas'

import { protectCourseBuilderRequest } from '@/coursebuilder/coursebuilder-request-authorization'
import {
	recordPaidCouponUse,
	withEffectivePaidCouponUsage,
	withPaidCouponUsage,
} from './paid-coupon-usage'

const uri = process.env.AIH_PAID_COUPON_MYSQL_URL
const productId = 'product-ma254'
const merchantCoupon = {
	id: 'merchant-test',
	type: 'special',
	status: 1,
	amountDiscount: 10_000,
}

function safeTestUrl(url: string) {
	const parsed = new URL(url)
	if (
		parsed.protocol !== 'mysql:' ||
		parsed.hostname !== '127.0.0.1' ||
		parsed.pathname !== '/couponsingle_app'
	) {
		throw new Error('requires disposable couponsingle_app MySQL fixture')
	}
	return url
}

describe.skipIf(!uri)(
	'paid coupon usage with a real MySQL counter and purchase rows',
	() => {
		let pool: Pool
		let db: DbExecutor

		beforeAll(async () => {
			pool = mysql.createPool({ uri: safeTestUrl(uri!), connectionLimit: 4 })
			db = drizzle(pool) as unknown as DbExecutor
			await pool.query(`CREATE TABLE AI_Coupon (
			id varchar(191) PRIMARY KEY, usedCount INT NOT NULL DEFAULT 0, maxUses INT NOT NULL
		)`)
			await pool.query(`CREATE TABLE AI_Purchase (
			id varchar(191) PRIMARY KEY, productId varchar(191) NOT NULL, couponId varchar(191), status varchar(191) NOT NULL,
			bulkCouponId varchar(191), redeemedBulkCouponId varchar(191), merchantChargeId varchar(191),
			totalAmount DECIMAL(10,2) NOT NULL, fields JSON, INDEX (productId), INDEX (bulkCouponId), INDEX (redeemedBulkCouponId)
		)`)
		})

		afterAll(async () => {
			await pool?.end()
		})

		const createCoupon = (id: string, maxUses = 1, usedCount = 0) =>
			pool.execute('INSERT INTO AI_Coupon VALUES (?, ?, ?)', [
				id,
				usedCount,
				maxUses,
			])
		const createPurchase = (
			id: string,
			couponId: string | null,
			{
				status = 'Valid',
				bulkCouponId = null,
				redeemedBulkCouponId = null,
				paid = true,
			}: {
				status?: string
				bulkCouponId?: string | null
				redeemedBulkCouponId?: string | null
				paid?: boolean
			} = {},
		) =>
			pool.execute(
				"INSERT INTO AI_Purchase VALUES (?, ?, ?, ?, ?, ?, ?, ?, JSON_OBJECT('testField', 1))",
				[
					id,
					productId,
					couponId,
					status,
					bulkCouponId,
					redeemedBulkCouponId,
					paid ? `charge-${id}` : null,
					paid ? 199 : 0,
				],
			)

		async function readCoupon(id: string) {
			const [rows] = await pool.execute<mysql.RowDataPacket[]>(
				'SELECT * FROM AI_Coupon WHERE id = ?',
				[id],
			)
			if (!rows[0]) return null
			return couponSchema.parse({
				...rows[0],
				merchantCouponId: merchantCoupon.id,
				createdAt: null,
				expires: null,
				percentageDiscount: 0,
				restrictedToProductId: productId,
				status: 1,
				default: false,
			})
		}

		const adapterFor = () =>
			withPaidCouponUsage(
				{
					getCoupon: readCoupon,
					couponForIdOrCode: async () => null,
					getDefaultCoupon: async () => null,
					getMerchantCoupon: async () => merchantCoupon,
					getEntitlementTypeByName: async () => null,
					getEntitlementsForUser: async () => [],
					getProduct: async () => ({ id: productId, type: 'self-paced' }),
					getPriceForProduct: async () => ({
						id: 'price-test',
						unitAmount: 299,
					}),
					getPurchasesForUser: async () => [],
				} as unknown as CommerceAdapter,
				db,
			)

		const request = (
			path: string,
			init?: ConstructorParameters<typeof NextRequest>[1],
		) => new NextRequest(`https://example.test/api/coursebuilder${path}`, init)

		it.each(['Valid', 'Restricted'])(
			'stops pricing and checkout after a %s purchase, before accounting',
			async (status) => {
				const id = `coupon-${status}`
				await createCoupon(id)
				const adapter = adapterFor()
				const checkout = request(
					`/checkout/stripe?productId=${productId}&couponId=${merchantCoupon.id}&usedCouponId=${id}`,
					{ method: 'POST' },
				)
				const price = request('/prices-formatted', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						productId,
						quantity: 1,
						couponId: id,
						merchantCoupon,
					}),
				})
				const unusedCheckout = await protectCourseBuilderRequest(checkout, {
					adapter,
				})
				expect(unusedCheckout.nextUrl.searchParams.get('usedCouponId')).toBe(id)
				const unusedPricing = await protectCourseBuilderRequest(price, {
					adapter,
				})
				const input = await unusedPricing.json()
				const formatted = await formatPricesForProduct({
					ctx: adapter,
					productId: input.productId,
					quantity: input.quantity,
					usedCouponId: input.couponId,
					merchantCouponId: input.merchantCoupon?.id,
					autoApplyPPP: false,
				})
				expect(formatted).toMatchObject({
					calculatedPrice: 199,
					usedCouponId: id,
				})

				await createPurchase(`purchase-${status}`, id, { status })
				const stored = (await readCoupon(id))!
				expect(stored.usedCount).toBe(0)
				// Unrestricted coupons use only the stored counter until a couponId index exists.
				const globalCoupon = { ...stored, restrictedToProductId: null }
				expect(await withEffectivePaidCouponUsage(db, globalCoupon)).toBe(globalCoupon)
				const otherProduct = { ...stored, restrictedToProductId: 'product-other' }
				expect(await withEffectivePaidCouponUsage(db, otherProduct)).toBe(otherProduct)
				expect(await getCouponForCode(id, [productId], adapter)).toMatchObject({
					isValid: false,
					isUsedUp: true,
				})
				await expect(
					protectCourseBuilderRequest(price, { adapter }),
				).rejects.toThrow('coupon-used-up')
				await expect(
					protectCourseBuilderRequest(checkout, { adapter }),
				).rejects.toThrow('coupon-used-up')
			},
		)

		it('counts paid uses once per purchase, even for concurrent replay, without replacing its fields', async () => {
			await createCoupon('coupon-replay', 2)
			await createPurchase('purchase-replay', 'coupon-replay')
			const replays = await Promise.all([
				recordPaidCouponUse(db, 'purchase-replay'),
				recordPaidCouponUse(db, 'purchase-replay'),
			])
			expect(replays.sort()).toEqual(['already-counted', 'counted'])
			expect(await recordPaidCouponUse(db, 'purchase-replay')).toBe(
				'already-counted',
			)
			expect((await readCoupon('coupon-replay'))?.usedCount).toBe(1)
			const [rows] = await pool.query<mysql.RowDataPacket[]>(
				"SELECT fields FROM AI_Purchase WHERE id = 'purchase-replay'",
			)
			expect(rows[0]?.fields).toMatchObject({
				testField: 1,
				paidCouponUseCounted: true,
			})
			await createPurchase('purchase-next', 'coupon-replay', {
				status: 'Restricted',
			})
			await pool.execute('UPDATE AI_Purchase SET fields = ? WHERE id = ?', ['null', 'purchase-next'])
			expect(await recordPaidCouponUse(db, 'purchase-next')).toBe('counted')
			expect(await recordPaidCouponUse(db, 'purchase-next')).toBe('already-counted')
			expect((await readCoupon('coupon-replay'))?.usedCount).toBe(2)
		})

		it('honors the stored count, ignores refunded rows, and leaves team and comp accounting alone', async () => {
			await createCoupon('coupon-counter', 1, 1)
			await createCoupon('coupon-refund')
			await createCoupon('coupon-team', 2, 1)
			await createCoupon('coupon-comp')
			await createPurchase('purchase-refund', 'coupon-refund', {
				status: 'Refunded',
			})
			await createPurchase('purchase-team', null, {
				bulkCouponId: 'coupon-team',
			})
			await createPurchase('purchase-seat', 'coupon-team', {
				redeemedBulkCouponId: 'coupon-team',
			})
			await createPurchase('purchase-team-provenance', 'coupon-team')
			await createPurchase('purchase-comp', 'coupon-comp', { paid: false })
			const adapter = adapterFor()
			expect(
				await getCouponForCode('coupon-counter', [productId], adapter),
			).toMatchObject({ isUsedUp: true })
			expect(
				await getCouponForCode('coupon-refund', [productId], adapter),
			).toMatchObject({ isValid: true })
			expect((await adapter.getCoupon('coupon-team'))?.usedCount).toBe(1)
			for (const id of [
				'purchase-refund',
				'purchase-team',
				'purchase-seat',
				'purchase-team-provenance',
				'purchase-comp',
			]) {
				expect(await recordPaidCouponUse(db, id)).toBe('ineligible')
			}
			expect((await readCoupon('coupon-team'))?.usedCount).toBe(1)
			expect((await readCoupon('coupon-comp'))?.usedCount).toBe(0)
		})
	},
)
