import { db } from '@/db'
import {
	coupon,
	merchantCharge,
	merchantSession,
	products,
	purchases,
	users,
} from '@/db/schema'
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm'

import {
	LIVE_PURCHASE_LIMIT,
	MAX_PURCHASE_LIMIT,
	type AdminGlobeProductOption,
	type PurchaseTickerHit,
} from './admin-sales-globe-contract'
import {
	readCachedGlobeLocation,
	resolveGlobeLocation,
} from './admin-sales-globe-geo'
import type { GlobeEnrichmentRow } from './admin-sales-globe-stripe-geo'

export {
	LIVE_PURCHASE_LIMIT,
	MAX_PURCHASE_LIMIT,
} from './admin-sales-globe-contract'

const DEFAULT_PURCHASE_LIMIT = 50
const PAID_PURCHASE_STATUSES = ['Valid', 'Restricted'] as const

export type PurchaseTickerRow = Readonly<{
	id: string
	createdAt: Date
	totalAmount: string
	productName: string | null
	productId: string
	country: string | null
	city: string | null
	state: string | null
	fields: unknown
	sessionIdentifier: string | null
	chargeIdentifier: string | null
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
	productId: string | null | undefined
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
			city: purchases.city,
			state: purchases.state,
			fields: purchases.fields,
			sessionIdentifier: merchantSession.identifier,
			chargeIdentifier: merchantCharge.identifier,
			userName: users.name,
			userEmail: users.email,
			userImage: users.image,
			bulkCouponMaxUses: coupon.maxUses,
		})
		.from(purchases)
		.leftJoin(products, eq(purchases.productId, products.id))
		.leftJoin(users, eq(purchases.userId, users.id))
		.leftJoin(coupon, eq(purchases.bulkCouponId, coupon.id))
		.leftJoin(
			merchantSession,
			eq(purchases.merchantSessionId, merchantSession.id)
		)
		.leftJoin(merchantCharge, eq(purchases.merchantChargeId, merchantCharge.id))
		.where(
			and(
				inArray(purchases.status, [...PAID_PURCHASE_STATUSES]),
				gt(purchases.totalAmount, '0'),
				pinnedProductId ? eq(purchases.productId, pinnedProductId) : undefined
			)
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

function locationForRow(row: PurchaseTickerRow) {
	const country = normalizeCountry(row.country)
	const cached = readCachedGlobeLocation(row.fields)
	if (cached) return cached
	return resolveGlobeLocation({
		country,
		city: optionalTrimmed(row.city),
		region: optionalTrimmed(row.state),
	})
}

export function mapPurchaseTickerRows(
	rows: readonly PurchaseTickerRow[]
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
		const country = normalizeCountry(row.country)
		const location = locationForRow(row)

		return {
			id: row.id,
			createdAt: row.createdAt,
			amount,
			productName: row.productName ?? '(unknown)',
			productId: row.productId,
			country,
			userName: optionalTrimmed(row.userName),
			userEmail: optionalTrimmed(row.userEmail),
			userImage: optionalTrimmed(row.userImage),
			city: location?.city ?? optionalTrimmed(row.city),
			region: location?.region ?? optionalTrimmed(row.state),
			lat: location?.lat ?? null,
			lng: location?.lng ?? null,
			isTeam: seats !== null,
			seats,
		}
	})
}

function enrichmentRowsFrom(
	rows: readonly PurchaseTickerRow[]
): GlobeEnrichmentRow[] {
	return rows.map((row) => ({
		id: row.id,
		country: normalizeCountry(row.country),
		fields: row.fields,
		sessionIdentifier: optionalTrimmed(row.sessionIdentifier),
		chargeIdentifier: optionalTrimmed(row.chargeIdentifier),
	}))
}

export async function getRecentPaidPurchases({
	limit,
	productId,
}: {
	limit?: number
	productId?: string | null
} = {}): Promise<PurchaseTickerHit[]> {
	const rows = await buildRecentPaidPurchasesQuery({ limit, productId })
	const hits = mapPurchaseTickerRows(rows)
	try {
		const { env } = await import('@/env.mjs')
		const Stripe = (await import('stripe')).default
		const { enrichGlobeHitsFromStripe, readStripeBillingAddress } =
			await import('./admin-sales-globe-stripe-geo')
		const stripe = new Stripe(env.STRIPE_SECRET_TOKEN, {
			apiVersion: '2024-06-20',
		})
		return await enrichGlobeHitsFromStripe({
			hits,
			rows: enrichmentRowsFrom(rows),
			readBilling: (row) =>
				readStripeBillingAddress({
					sessionIdentifier: row.sessionIdentifier,
					chargeIdentifier: row.chargeIdentifier,
					stripe,
				}),
		})
	} catch {
		return hits
	}
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
