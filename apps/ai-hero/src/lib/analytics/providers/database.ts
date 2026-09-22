import { asc, and, count, desc, eq, gte, inArray } from 'drizzle-orm'
import { db } from '@/db'
import * as schema from '@/db/schema'

import { createDatabaseProvider } from '@coursebuilder/analytics/providers/database'

import type { AnalyticsRange } from '../types'

const provider = createDatabaseProvider(db, schema)

export const {
	getRevenueSummary,
	getRevenueByDay,
	getPreviousPeriodRevenueByDay,
	getRevenueByProduct,
	getRevenueByCountry,
	getRecentPurchases,
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
			clicks: count().as('clicks'),
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

export default { ...provider, getShortlinkPerformance }
