import { db } from '@/db'
import { coupon, products, purchases, users } from '@/db/schema'
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm'

import {
	LIVE_PURCHASE_LIMIT,
	MAX_PURCHASE_LIMIT,
	type AdminGlobeProductOption,
	type PurchaseTickerHit,
} from './admin-sales-globe-contract'

export { LIVE_PURCHASE_LIMIT, MAX_PURCHASE_LIMIT } from './admin-sales-globe-contract'

const DEFAULT_PURCHASE_LIMIT = 50
const PAID_PURCHASE_STATUSES = ['Valid', 'Restricted'] as const

export type PurchaseTickerRow = Readonly<{
	id: string
	createdAt: Date
	totalAmount: string
	productName: string | null
	productId: string
	country: string | null
	userName: string | null
	userEmail: string | null
	userImage: string | null
	bulkCouponMaxUses: number | null
}>

export function normalizePurchaseLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) {
		return DEFAULT_PURCHASE_LIMIT
	}
	return Math.max(1, Math.min(Math.trunc(limit), MAX_PURCHASE_LIMIT))
}

/**
 * Optional product pin for history and replay. `all` and empty mean every product.
 */
export function normalizeProductId(
	productId: string | null | undefined,
): string | undefined {
	const value = productId?.trim()
	if (!value || value === 'all' || value.length > 128) return undefined
	return value
}

export function buildRecentPaidPurchasesQuery({
	database = db,
	limit,
	productId,
}: {
	database?: typeof db
	limit?: number
	productId?: string | null
} = {}) {
	const pinnedProductId = normalizeProductId(productId)
	return database
		.select({
			id: purchases.id,
			createdAt: purchases.createdAt,
			totalAmount: purchases.totalAmount,
			productName: products.name,
			productId: purchases.productId,
			country: purchases.country,
			userName: users.name,
			userEmail: users.email,
			userImage: users.image,
			bulkCouponMaxUses: coupon.maxUses,
		})
		.from(purchases)
		.leftJoin(products, eq(purchases.productId, products.id))
		.leftJoin(users, eq(purchases.userId, users.id))
		.leftJoin(coupon, eq(purchases.bulkCouponId, coupon.id))
		.where(
			and(
				inArray(purchases.status, [...PAID_PURCHASE_STATUSES]),
				gt(purchases.totalAmount, '0'),
				pinnedProductId ? eq(purchases.productId, pinnedProductId) : undefined,
			),
		)
		.orderBy(desc(purchases.createdAt), desc(purchases.id))
		.limit(normalizePurchaseLimit(limit))
}

function normalizeCountry(country: string | null): string | null {
	const normalized = country?.trim().toUpperCase()
	return normalized && /^[A-Z]{2}$/.test(normalized) ? normalized : null
}

function optionalTrimmed(value: string | null): string | null {
	const normalized = value?.trim()
	return normalized ? normalized : null
}

export function mapPurchaseTickerRows(
	rows: readonly PurchaseTickerRow[],
): PurchaseTickerHit[] {
	return rows.map((row) => {
		const amount = Number(row.totalAmount)
		if (!Number.isFinite(amount) || amount <= 0) {
			throw new Error(`Invalid paid purchase amount for ${row.id}`)
		}

		const seats =
			typeof row.bulkCouponMaxUses === 'number' && row.bulkCouponMaxUses > 1
				? row.bulkCouponMaxUses
				: null

		return {
			id: row.id,
			createdAt: row.createdAt,
			amount,
			productName: row.productName ?? '(unknown)',
			productId: row.productId,
			country: normalizeCountry(row.country),
			userName: optionalTrimmed(row.userName),
			userEmail: optionalTrimmed(row.userEmail),
			userImage: optionalTrimmed(row.userImage),
			isTeam: seats !== null,
			seats,
		}
	})
}

export async function getRecentPaidPurchases({
	limit,
	productId,
}: {
	limit?: number
	productId?: string | null
} = {}): Promise<PurchaseTickerHit[]> {
	const rows = await buildRecentPaidPurchasesQuery({ limit, productId })
	return mapPurchaseTickerRows(rows)
}

/**
 * Product names for the admin globe pin and replay controls.
 */
export async function getAdminGlobeProductOptions({
	database = db,
}: {
	database?: typeof db
} = {}): Promise<AdminGlobeProductOption[]> {
	const rows = await database
		.select({
			id: products.id,
			name: products.name,
		})
		.from(products)
		.orderBy(asc(products.name))

	return rows.flatMap((row) => {
		const name = row.name?.trim()
		return name ? [{ id: row.id, name }] : []
	})
}
