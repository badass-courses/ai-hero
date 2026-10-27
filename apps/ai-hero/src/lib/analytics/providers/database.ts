import {
	asc,
	and,
	count,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	lte,
	or,
	type SQL,
} from 'drizzle-orm'
import { db } from '@/db'
import * as schema from '@/db/schema'

import { createDatabaseProvider } from '@coursebuilder/analytics/providers/database'

import type { AnalyticsRange } from '../types'
import {
	formatPromoRevenue,
	promoWindow,
	parsePromoAggregateRows,
	type PromoOptions,
} from '../promos'
import { promoRevenueSql } from '../promos-query'

export async function getRevenueByPromo(options: PromoOptions = {}) {
	const window = promoWindow(options)
	const result = await db.execute(promoRevenueSql(options, window))
	return formatPromoRevenue(parsePromoAggregateRows(result), window)
}

const provider = createDatabaseProvider(db, schema)

export const {
	getRevenueSummary,
	getRevenueByDay,
	getPreviousPeriodRevenueByDay,
	getRevenueByProduct,
	getRevenueByCountry,
	getAttributionSummary,
	getRevenueBySource,
	getConversionFunnel,
	getCommerceLaneSummary,
	getAttributedRevenueSummary,
	getContentPurchaseCorrelation,
	getCheckoutAttributionReceipt,
	getCheckoutSurveyFallbackReport,
	getValuePathSummary,
} = provider

type ShortlinkPerformanceRow = {
	shortlinkId: string
	slug: string
	url: string
	clicks: number | bigint
}

type ShortlinkAttributionCount = {
	shortlinkId: string
	type: string
	count: number | bigint
}

/** Format the already-ranked SQL result without changing its order. */
export function formatShortlinkPerformance(
	rows: readonly ShortlinkPerformanceRow[],
	attrRows: readonly ShortlinkAttributionCount[],
) {
	const selectedRows = rows.slice(0, 20)
	const selectedIds = new Set(selectedRows.map((row) => row.shortlinkId))
	const attrMap = new Map<string, { signups: number; purchases: number }>()
	for (const row of attrRows) {
		if (!selectedIds.has(row.shortlinkId)) continue
		const existing = attrMap.get(row.shortlinkId) ?? {
			signups: 0,
			purchases: 0,
		}
		if (row.type === 'signup') existing.signups = Number(row.count ?? 0)
		if (row.type === 'purchase') existing.purchases = Number(row.count ?? 0)
		attrMap.set(row.shortlinkId, existing)
	}

	return selectedRows.map((row) => {
		const attr = attrMap.get(row.shortlinkId)
		return {
			shortlinkId: row.shortlinkId,
			slug: row.slug,
			url: row.url,
			clicks: Number(row.clicks ?? 0),
			signups: attr?.signups ?? 0,
			purchases: attr?.purchases ?? 0,
		}
	})
}

function rangeToDate(range: AnalyticsRange) {
	if (range === 'all') return null
	const hours: Record<string, number> = {
		'24h': 24,
		'7d': 7 * 24,
		'30d': 30 * 24,
		'90d': 90 * 24,
	}
	return new Date(
		Date.now() - (hours[range] ?? 30 * 24) * 60 * 60 * 1000,
	)
}

/**
 * Aggregate the large click table before joining shortlink metadata. The
 * metadata inner join keeps deleted links out, matching the previous
 * behavior, while attribution is bounded to the selected top twenty IDs.
 */
export async function getShortlinkPerformance(
	range: AnalyticsRange = '30d',
	database: typeof db = db,
) {
	const since = rangeToDate(range)
	const clickConditions = since
		? [gte(schema.shortlinkClick.timestamp, since)]
		: []

	const clickCounts = database
		.select({
			shortlinkId: schema.shortlinkClick.shortlinkId,
			// Drizzle emits aggregate aliases unqualified in the outer query.
			// Avoid colliding with Shortlink.clicks (the cached lifetime count).
			clicks: count().as('shortlink_event_count'),
		})
		.from(schema.shortlinkClick)
		.where(clickConditions.length > 0 ? and(...clickConditions) : undefined)
		.groupBy(schema.shortlinkClick.shortlinkId)
		.as('shortlink_click_counts')

	const rows = await database
		.select({
			shortlinkId: clickCounts.shortlinkId,
			slug: schema.shortlink.slug,
			url: schema.shortlink.url,
			clicks: clickCounts.clicks,
		})
		.from(clickCounts)
		.innerJoin(
			schema.shortlink,
			eq(clickCounts.shortlinkId, schema.shortlink.id),
		)
		.orderBy(desc(clickCounts.clicks), asc(clickCounts.shortlinkId))
		.limit(20)

	const selectedIds = rows.slice(0, 20).map((row: any) => row.shortlinkId)
	if (selectedIds.length === 0) return []

	const attrConditions = [
		inArray(schema.shortlinkAttribution.shortlinkId, selectedIds),
		...(since ? [gte(schema.shortlinkAttribution.createdAt, since)] : []),
	]
	const attrRows = await database
		.select({
			shortlinkId: schema.shortlinkAttribution.shortlinkId,
			type: schema.shortlinkAttribution.type,
			count: count(),
		})
		.from(schema.shortlinkAttribution)
		.where(and(...attrConditions))
		.groupBy(
			schema.shortlinkAttribution.shortlinkId,
			schema.shortlinkAttribution.type,
		)

	return formatShortlinkPerformance(rows as ShortlinkPerformanceRow[], attrRows as ShortlinkAttributionCount[])
}

export type RecentPurchaseKind = 'all' | 'team' | 'individual'

const PAID_PURCHASE_STATUSES = ['Valid', 'Restricted'] as const

type RecentPurchaseRow = {
	id: string
	createdAt: Date
	totalAmount: string | number
	productName: string | null
	productId: string
	country: string | null
	couponId: string | null
	userName: string | null
	userEmail: string | null
	bulkCouponId: string | null
	bulkCouponMaxUses: number | null
}

type BulkCouponPurchaseCount = {
	bulkCouponId: string | null
	purchases: number | bigint
}

/**
 * Team facts for one purchase. A team purchase has a bulk coupon with more
 * than one seat, the same rule the admin sales globe uses. An organization
 * alone is not a team: every cohort checkout creates one.
 *
 * Add-seat purchases reuse the team's bulk coupon and raise maxUses, and no
 * table stores a per-purchase quantity. So seats is only known when this is
 * the coupon's only purchase; teamSeats is always the team's current total.
 */
export function recentPurchaseTeamFacts(
	bulkCouponMaxUses: number | null,
	bulkCouponPurchases: number,
) {
	const teamSeats =
		typeof bulkCouponMaxUses === 'number' && bulkCouponMaxUses > 1
			? bulkCouponMaxUses
			: null
	return {
		isTeam: teamSeats !== null,
		seats: teamSeats !== null && bulkCouponPurchases === 1 ? teamSeats : null,
		teamSeats,
	}
}

export function formatRecentPurchases(
	rows: readonly RecentPurchaseRow[],
	couponCounts: readonly BulkCouponPurchaseCount[],
) {
	const purchasesByCoupon = new Map<string, number>()
	for (const row of couponCounts) {
		if (row.bulkCouponId)
			purchasesByCoupon.set(row.bulkCouponId, Number(row.purchases ?? 0))
	}

	return rows.map((row) => ({
		id: row.id,
		createdAt: row.createdAt,
		totalAmount: Number(row.totalAmount),
		productName: row.productName ?? '(unknown)',
		productId: row.productId,
		country: row.country,
		couponId: row.couponId,
		userName: row.userName ?? null,
		userEmail: row.userEmail ?? null,
		...recentPurchaseTeamFacts(
			row.bulkCouponId ? row.bulkCouponMaxUses : null,
			row.bulkCouponId ? (purchasesByCoupon.get(row.bulkCouponId) ?? 0) : 0,
		),
	}))
}

function teamCondition(): SQL {
	return gt(schema.coupon.maxUses, 1)
}

function individualCondition(): SQL {
	return or(
		isNull(schema.purchases.bulkCouponId),
		isNull(schema.coupon.maxUses),
		lte(schema.coupon.maxUses, 1),
	)!
}

/**
 * Overrides `@coursebuilder/analytics` getRecentPurchases, which reads
 * organizationId as the team signal and leaves seats null on the default
 * path. Same arguments, order, paging and filters. Two queries per page:
 * the purchases with their bulk coupon, then purchase counts for that page's
 * bulk coupons. The counts cover every purchase on the coupon, any status
 * and any date, so an earlier or refunded add-seat purchase still marks the
 * per-purchase seat count as unknown.
 */
export async function getRecentPurchases(
	limit: number = 20,
	filter: RecentPurchaseKind = 'all',
	range: AnalyticsRange = 'all',
	filters: { productId?: string; offset?: number } = {},
	database: typeof db = db,
) {
	const since = rangeToDate(range)
	const conditions: SQL[] = [
		inArray(schema.purchases.status, [...PAID_PURCHASE_STATUSES]),
		gt(schema.purchases.totalAmount, '0'),
	]
	if (since) conditions.push(gte(schema.purchases.createdAt, since))
	if (filters.productId)
		conditions.push(eq(schema.purchases.productId, filters.productId))
	if (filter === 'team') conditions.push(teamCondition())
	if (filter === 'individual') conditions.push(individualCondition())

	const rows = await database
		.select({
			id: schema.purchases.id,
			createdAt: schema.purchases.createdAt,
			totalAmount: schema.purchases.totalAmount,
			productName: schema.products.name,
			productId: schema.purchases.productId,
			country: schema.purchases.country,
			couponId: schema.purchases.couponId,
			userName: schema.users.name,
			userEmail: schema.users.email,
			bulkCouponId: schema.purchases.bulkCouponId,
			bulkCouponMaxUses: schema.coupon.maxUses,
		})
		.from(schema.purchases)
		.leftJoin(
			schema.products,
			eq(schema.purchases.productId, schema.products.id),
		)
		.leftJoin(schema.users, eq(schema.purchases.userId, schema.users.id))
		.leftJoin(
			schema.coupon,
			eq(schema.purchases.bulkCouponId, schema.coupon.id),
		)
		.where(and(...conditions))
		.orderBy(desc(schema.purchases.createdAt), desc(schema.purchases.id))
		.limit(limit)
		.offset(filters.offset ?? 0)

	const teamCouponIds = [
		...new Set(
			(rows as RecentPurchaseRow[])
				.filter(
					(row) =>
						row.bulkCouponId &&
						typeof row.bulkCouponMaxUses === 'number' &&
						row.bulkCouponMaxUses > 1,
				)
				.map((row) => row.bulkCouponId as string),
		),
	]
	const couponCounts =
		teamCouponIds.length === 0
			? []
			: await database
					.select({
						bulkCouponId: schema.purchases.bulkCouponId,
						purchases: count(),
					})
					.from(schema.purchases)
					.where(inArray(schema.purchases.bulkCouponId, teamCouponIds))
					.groupBy(schema.purchases.bulkCouponId)

	return formatRecentPurchases(
		rows as RecentPurchaseRow[],
		couponCounts as BulkCouponPurchaseCount[],
	)
}

export default { ...provider, getShortlinkPerformance, getRecentPurchases }
