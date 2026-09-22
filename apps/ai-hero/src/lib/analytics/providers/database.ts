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

type ShortlinkClickCount = { shortlinkId: string; clicks: number }

/** Keep ranking deterministic while retaining the provider's inner-join semantics. */
export function rankShortlinkClickCounts(
	rows: readonly ShortlinkClickCount[],
	availableShortlinkIds: ReadonlySet<string>,
	limit: number,
) {
	return rows
		.filter((row) => availableShortlinkIds.has(row.shortlinkId))
		.sort(
			(a, b) =>
				b.clicks - a.clicks || a.shortlinkId.localeCompare(b.shortlinkId),
		)
		.slice(0, limit)
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
 * outer join keeps deleted links out, matching the previous inner-join
 * behavior, while attribution is bounded to the selected top twenty IDs.
 */
export async function getShortlinkPerformance(
	range: AnalyticsRange = '30d',
) {
	const since = rangeToDate(range)
	const clickConditions = since
		? [gte(schema.shortlinkClick.timestamp, since)]
		: []

	const clickCounts = db
		.select({
			shortlinkId: schema.shortlinkClick.shortlinkId,
			clicks: count().as('clicks'),
		})
		.from(schema.shortlinkClick)
		.where(clickConditions.length > 0 ? and(...clickConditions) : undefined)
		.groupBy(schema.shortlinkClick.shortlinkId)
		.as('shortlink_click_counts')

	const rows = await db
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

	const rankedRows = rankShortlinkClickCounts(
		rows.map((row: any) => ({
			shortlinkId: row.shortlinkId,
			clicks: Number(row.clicks ?? 0),
		})),
		new Set(rows.map((row: any) => row.shortlinkId)),
		20,
	)
	const rowById = new Map(
		rows.map((row: any) => [row.shortlinkId, row] as const),
	)
	const selectedIds = rankedRows.map((row) => row.shortlinkId)
	if (selectedIds.length === 0) return []

	const attrConditions = [
		inArray(schema.shortlinkAttribution.shortlinkId, selectedIds),
		...(since ? [gte(schema.shortlinkAttribution.createdAt, since)] : []),
	]
	const attrRows = await db
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

	const attrMap = new Map<string, { signups: number; purchases: number }>()
	for (const row of attrRows as any[]) {
		const existing = attrMap.get(row.shortlinkId) ?? {
			signups: 0,
			purchases: 0,
		}
		if (row.type === 'signup') existing.signups = Number(row.count ?? 0)
		if (row.type === 'purchase') existing.purchases = Number(row.count ?? 0)
		attrMap.set(row.shortlinkId, existing)
	}

	return rankedRows.map((ranked) => {
		const row = rowById.get(ranked.shortlinkId)
		const attr = attrMap.get(ranked.shortlinkId)
		return {
			shortlinkId: ranked.shortlinkId,
			slug: row.slug,
			url: row.url,
			clicks: ranked.clicks,
			signups: attr?.signups ?? 0,
			purchases: attr?.purchases ?? 0,
		}
	})
}

export default { ...provider, getShortlinkPerformance }
