import { db } from '@/db'
import {
	merchantCharge,
	merchantSession,
	purchases,
} from '@/db/schema'
import { AI_CODING_CRASH_COURSE_PRODUCT_ID } from '@/lib/crash-course-purchaser-tag'
import { and, desc, eq, gt, inArray, isNotNull, isNull, or } from 'drizzle-orm'

import type { GlobeEnrichmentRow } from './admin-sales-globe-stripe-geo'

export const GLOBE_GEO_BACKFILL_DEFAULT_PRODUCT_ID =
	AI_CODING_CRASH_COURSE_PRODUCT_ID
export const GLOBE_GEO_BACKFILL_DEFAULT_LIMIT = 200
export const GLOBE_GEO_BACKFILL_MAX_LIMIT = 500
export const GLOBE_GEO_BACKFILL_CONCURRENCY = 6

const PAID_PURCHASE_STATUSES = ['Valid', 'Restricted'] as const

export type GlobeGeoBackfillRow = GlobeEnrichmentRow

export type GlobeGeoBackfillArgs = {
	allowWrite: boolean
	limit: number
	productId: string | null
}

/**
 * Parse the one-shot globe geo backfill CLI.
 */
export function parseGlobeGeoBackfillArgs(
	argv: string[]
): GlobeGeoBackfillArgs {
	let allowWrite = false
	let dryRun = false
	let allProducts = false
	let limit = GLOBE_GEO_BACKFILL_DEFAULT_LIMIT
	let productId: string | null = GLOBE_GEO_BACKFILL_DEFAULT_PRODUCT_ID

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (arg === '--allow-write') {
			allowWrite = true
			continue
		}
		if (arg === '--dry-run') {
			dryRun = true
			continue
		}
		if (arg === '--all-products') {
			allProducts = true
			continue
		}
		if (arg === '--product-id') {
			productId = argv[index + 1]?.trim() || null
			index += 1
			continue
		}
		if (arg === '--limit') {
			const parsed = Number(argv[index + 1])
			index += 1
			if (Number.isFinite(parsed)) {
				limit = Math.max(
					1,
					Math.min(Math.trunc(parsed), GLOBE_GEO_BACKFILL_MAX_LIMIT)
				)
			}
		}
	}

	if (allowWrite && dryRun) {
		throw new Error('Pass --dry-run or --allow-write, not both')
	}

	return {
		allowWrite,
		limit,
		productId: allProducts ? null : productId,
	}
}

/**
 * Paid purchases that still have an empty city and a Stripe session or charge.
 */
export function buildGlobeGeoBackfillQuery({
	database = db,
	limit = GLOBE_GEO_BACKFILL_DEFAULT_LIMIT,
	productId = GLOBE_GEO_BACKFILL_DEFAULT_PRODUCT_ID,
}: {
	database?: typeof db
	limit?: number
	productId?: string | null
} = {}) {
	const pinnedProductId = productId?.trim() || null
	return database
		.select({
			id: purchases.id,
			country: purchases.country,
			city: purchases.city,
			state: purchases.state,
			ipAddress: purchases.ipAddress,
			fields: purchases.fields,
			sessionIdentifier: merchantSession.identifier,
			chargeIdentifier: merchantCharge.identifier,
		})
		.from(purchases)
		.leftJoin(
			merchantSession,
			eq(purchases.merchantSessionId, merchantSession.id)
		)
		.leftJoin(
			merchantCharge,
			eq(purchases.merchantChargeId, merchantCharge.id)
		)
		.where(
			and(
				inArray(purchases.status, [...PAID_PURCHASE_STATUSES]),
				gt(purchases.totalAmount, '0'),
				isNull(purchases.city),
				or(
					isNotNull(merchantSession.identifier),
					isNotNull(merchantCharge.identifier)
				),
				pinnedProductId ? eq(purchases.productId, pinnedProductId) : undefined
			)
		)
		.orderBy(desc(purchases.createdAt), desc(purchases.id))
		.limit(
			Math.max(1, Math.min(Math.trunc(limit), GLOBE_GEO_BACKFILL_MAX_LIMIT))
		)
}

/**
 * One purchase plus Stripe session/charge identifiers for geo persist.
 */
export function buildPurchaseGeoRowQuery({
	database = db,
	purchaseId,
}: {
	database?: typeof db
	purchaseId: string
}) {
	return database
		.select({
			id: purchases.id,
			country: purchases.country,
			city: purchases.city,
			state: purchases.state,
			ipAddress: purchases.ipAddress,
			fields: purchases.fields,
			sessionIdentifier: merchantSession.identifier,
			chargeIdentifier: merchantCharge.identifier,
		})
		.from(purchases)
		.leftJoin(
			merchantSession,
			eq(purchases.merchantSessionId, merchantSession.id)
		)
		.leftJoin(
			merchantCharge,
			eq(purchases.merchantChargeId, merchantCharge.id)
		)
		.where(eq(purchases.id, purchaseId))
		.limit(1)
}

export function globeGeoBackfillRowFromQuery(row: {
	id: string
	country: string | null
	city: string | null
	state: string | null
	ipAddress: string | null
	fields: unknown
	sessionIdentifier: string | null
	chargeIdentifier: string | null
}): GlobeGeoBackfillRow {
	return {
		id: row.id,
		country: row.country,
		city: row.city,
		state: row.state,
		ipAddress: row.ipAddress,
		fields: row.fields,
		sessionIdentifier: row.sessionIdentifier,
		chargeIdentifier: row.chargeIdentifier,
	}
}
