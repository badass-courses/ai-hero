import { db } from '@/db'
import {
	purchases,
	shortlink,
	shortlinkAttribution,
	shortlinkClick,
} from '@/db/schema'
import { getBroadcastsWithClicks, isKitConfigured } from '@/lib/kit-data'
import { and, count, eq, gte, inArray, sql, sum } from 'drizzle-orm'

import type { AnalyticsRange } from '../types'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EmailCampaignKitLink {
	url: string
	uniqueClicks: number
	clickToDeliveryRate: number
	clickToOpenRate: number
	shortlinkSlug?: string | null
}

export interface EmailCampaignFunnel {
	broadcastId: number
	subject: string
	sentAt: string | null
	// Kit metrics (top of funnel)
	recipients: number
	openRate: number
	emailsOpened?: number
	clickRate: number
	totalClicks: number
	showTotalClicks?: boolean
	unsubscribes: number
	unsubscribeRate?: number
	progress?: number
	openTrackingDisabled?: boolean
	clickTrackingDisabled?: boolean
	kitLinks?: EmailCampaignKitLink[]
	// Per-shortlink attribution (bottom of funnel)
	shortlinks: {
		slug: string
		url: string
		kitClicks: number // clicks reported by Kit for this link
		clickToDeliveryRate?: number
		clickToOpenRate?: number
		shortlinkClicks: number // clicks tracked by our shortlink system
		signups: number
		purchases: number
		revenue: number
	}[]
	// Aggregated bottom-of-funnel
	totalSignups: number
	totalPurchases: number
	totalRevenue: number
	clickToPurchaseRate: number
}

export interface EmailRevenueOverview {
	configured: boolean
	totalBroadcasts: number
	totalRecipients: number
	totalRevenue: number
	campaigns: EmailCampaignFunnel[]
}

const PAID_STATUSES = ['Valid', 'Restricted'] as const

// ─── Range filter ────────────────────────────────────────────────────────────

function rangeToDate(range: AnalyticsRange): Date | null {
	if (range === 'all') return null
	const hours: Record<string, number> = {
		'24h': 24,
		'7d': 7 * 24,
		'30d': 30 * 24,
		'90d': 90 * 24,
	}
	return new Date(Date.now() - (hours[range] ?? 30 * 24) * 60 * 60 * 1000)
}

// ─── Main function ───────────────────────────────────────────────────────────

function getShortlinkSlugsFromBroadcasts(
	broadcasts: Awaited<ReturnType<typeof getBroadcastsWithClicks>>,
) {
	const shortlinkPattern = /aihero\.dev\/s\/([a-zA-Z0-9_-]+)/
	const allSlugsInEmails = new Set<string>()
	for (const b of broadcasts) {
		for (const click of b.clicks) {
			const match = click.url.match(shortlinkPattern)
			if (match) allSlugsInEmails.add(match[1]!)
		}
	}
	return allSlugsInEmails
}

export async function getEmailCampaignAttribution(
	range: AnalyticsRange,
	limit = 30,
): Promise<EmailRevenueOverview> {
	if (!isKitConfigured()) {
		return {
			configured: false,
			totalBroadcasts: 0,
			totalRecipients: 0,
			totalRevenue: 0,
			campaigns: [],
		}
	}

	const since = rangeToDate(range)

	// 1. Get broadcasts with per-link click data from Kit
	const broadcasts = await getBroadcastsWithClicks(limit)

	// Filter by range
	const filtered = since
		? broadcasts.filter((b) => b.sentAt && new Date(b.sentAt) >= since)
		: broadcasts

	// 2. Extract all aihero shortlink URLs from broadcast clicks
	const shortlinkPattern = /aihero\.dev\/s\/([a-zA-Z0-9_-]+)/
	const allSlugsInEmails = getShortlinkSlugsFromBroadcasts(filtered)

	// 3. Batch-lookup shortlink IDs, click counts, and attribution
	const slugToData = new Map<
		string,
		{
			id: string
			url: string
			shortlinkClicks: number
			signups: number
			purchases: number
			revenue: number
		}
	>()

	if (allSlugsInEmails.size > 0) {
		const slugList = [...allSlugsInEmails]
		const shortlinkRows = await db
			.select({ id: shortlink.id, slug: shortlink.slug, url: shortlink.url })
			.from(shortlink)
			.where(
				sql`${shortlink.slug} IN (${sql.join(
					slugList.map((s) => sql`${s}`),
					sql`, `,
				)})`,
			)

		const idToSlug = new Map<string, string>()
		for (const row of shortlinkRows) {
			idToSlug.set(row.id, row.slug)
			slugToData.set(row.slug, {
				id: row.id,
				url: row.url,
				shortlinkClicks: 0,
				signups: 0,
				purchases: 0,
				revenue: 0,
			})
		}

		// Get click counts per shortlink
		const shortlinkIds = shortlinkRows.map((r) => r.id)
		if (shortlinkIds.length > 0) {
			const clickConditions = [
				sql`${shortlinkClick.shortlinkId} IN (${sql.join(
					shortlinkIds.map((id) => sql`${id}`),
					sql`, `,
				)})`,
			]
			if (since) clickConditions.push(gte(shortlinkClick.timestamp, since))

			const clickRows = await db
				.select({
					shortlinkId: shortlinkClick.shortlinkId,
					count: count(),
				})
				.from(shortlinkClick)
				.where(and(...clickConditions))
				.groupBy(shortlinkClick.shortlinkId)

			for (const clickRow of clickRows) {
				const slug = idToSlug.get(clickRow.shortlinkId)
				if (!slug) continue
				const data = slugToData.get(slug)
				if (!data) continue
				data.shortlinkClicks = clickRow.count
			}

			// Get attribution counts per shortlink
			const attrConditions = [
				sql`${shortlinkAttribution.shortlinkId} IN (${sql.join(
					shortlinkIds.map((id) => sql`${id}`),
					sql`, `,
				)})`,
			]
			if (since) attrConditions.push(gte(shortlinkAttribution.createdAt, since))

			const attrRows = await db
				.select({
					shortlinkId: shortlinkAttribution.shortlinkId,
					type: shortlinkAttribution.type,
					count: count(),
				})
				.from(shortlinkAttribution)
				.where(and(...attrConditions))
				.groupBy(shortlinkAttribution.shortlinkId, shortlinkAttribution.type)

			for (const a of attrRows) {
				const slug = idToSlug.get(a.shortlinkId)
				if (!slug) continue
				const data = slugToData.get(slug)
				if (!data) continue
				if (a.type === 'signup') data.signups = a.count
				if (a.type === 'purchase') data.purchases = a.count
			}

			// Get revenue per shortlink (from purchase attributions → purchase amount)
			const purchaseAttrRows = await db
				.select({
					shortlinkId: shortlinkAttribution.shortlinkId,
					userId: shortlinkAttribution.userId,
				})
				.from(shortlinkAttribution)
				.where(
					and(
						sql`${shortlinkAttribution.shortlinkId} IN (${sql.join(
							shortlinkIds.map((id) => sql`${id}`),
							sql`, `,
						)})`,
						eq(shortlinkAttribution.type, 'purchase'),
						...(since ? [gte(shortlinkAttribution.createdAt, since)] : []),
					),
				)

			// Get purchase amounts for these users
			const purchaserUserIds = [
				...new Set(purchaseAttrRows.map((r) => r.userId).filter(Boolean)),
			] as string[]

			if (purchaserUserIds.length > 0) {
				const revRows = await db
					.select({
						userId: purchases.userId,
						revenue: sum(purchases.totalAmount),
					})
					.from(purchases)
					.where(
						and(
							inArray(purchases.status, [...PAID_STATUSES]),
							sql`${purchases.userId} IN (${sql.join(
								purchaserUserIds.map((id) => sql`${id}`),
								sql`, `,
							)})`,
						),
					)
					.groupBy(purchases.userId)

				const userRevenue = new Map(
					revRows.map((r) => [r.userId, Number(r.revenue ?? 0)]),
				)

				// Attribute revenue back to shortlinks
				for (const attr of purchaseAttrRows) {
					if (!attr.userId) continue
					const slug = idToSlug.get(attr.shortlinkId)
					if (!slug) continue
					const data = slugToData.get(slug)
					if (!data) continue
					data.revenue += userRevenue.get(attr.userId) ?? 0
				}
			}
		}
	}

	// 4. Build per-broadcast funnel
	const campaigns: EmailCampaignFunnel[] = filtered.map((b) => {
		const kitLinks = b.clicks.map((click) => {
			const match = click.url.match(shortlinkPattern)
			return {
				url: click.url,
				uniqueClicks: click.uniqueClicks,
				clickToDeliveryRate: click.clickToDeliveryRate,
				clickToOpenRate: click.clickToOpenRate,
				shortlinkSlug: match?.[1] ?? null,
			}
		})

		const shortlinks = b.clicks
			.map((click) => {
				const match = click.url.match(shortlinkPattern)
				if (!match) return null
				const slug = match[1]!
				const data = slugToData.get(slug)
				return {
					slug,
					url: data?.url ?? click.url,
					kitClicks: click.uniqueClicks,
					clickToDeliveryRate: click.clickToDeliveryRate,
					clickToOpenRate: click.clickToOpenRate,
					shortlinkClicks: data?.shortlinkClicks ?? 0,
					signups: data?.signups ?? 0,
					purchases: data?.purchases ?? 0,
					revenue: data?.revenue ?? 0,
				}
			})
			.filter(Boolean) as EmailCampaignFunnel['shortlinks']

		const totalSignups = shortlinks.reduce((s, l) => s + l.signups, 0)
		const totalPurchases = shortlinks.reduce((s, l) => s + l.purchases, 0)
		const totalRevenue = shortlinks.reduce((s, l) => s + l.revenue, 0)
		const totalKitClicks = shortlinks.reduce((s, l) => s + l.kitClicks, 0)

		return {
			broadcastId: b.id,
			subject: b.subject,
			sentAt: b.sentAt,
			recipients: b.stats.recipients,
			openRate: b.stats.openRate,
			emailsOpened: b.stats.emailsOpened,
			clickRate: b.stats.clickRate,
			totalClicks: b.stats.totalClicks,
			showTotalClicks: b.stats.showTotalClicks,
			unsubscribes: b.stats.unsubscribes,
			unsubscribeRate: b.stats.unsubscribeRate,
			progress: b.stats.progress,
			openTrackingDisabled: b.stats.openTrackingDisabled,
			clickTrackingDisabled: b.stats.clickTrackingDisabled,
			kitLinks,
			shortlinks,
			totalSignups,
			totalPurchases,
			totalRevenue,
			clickToPurchaseRate:
				totalKitClicks > 0 ? totalPurchases / totalKitClicks : 0,
		}
	})

	return {
		configured: true,
		totalBroadcasts: campaigns.length,
		totalRecipients: campaigns.reduce((s, c) => s + c.recipients, 0),
		totalRevenue: campaigns.reduce((s, c) => s + c.totalRevenue, 0),
		campaigns: campaigns.sort((a, b) => b.totalRevenue - a.totalRevenue),
	}
}

export async function getEmailCampaignAttributionStrict(
	range: AnalyticsRange,
	limit = 30,
	filters: { productId?: string } = {},
): Promise<EmailRevenueOverview> {
	if (!isKitConfigured()) {
		return {
			configured: false,
			totalBroadcasts: 0,
			totalRecipients: 0,
			totalRevenue: 0,
			campaigns: [],
		}
	}

	const since = rangeToDate(range)
	const shortlinkPattern = /aihero\.dev\/s\/([a-zA-Z0-9_-]+)/
	const broadcasts = await getBroadcastsWithClicks(limit)
	const filtered = since
		? broadcasts.filter((b) => b.sentAt && new Date(b.sentAt) >= since)
		: broadcasts
	const allSlugsInEmails = getShortlinkSlugsFromBroadcasts(filtered)
	const slugList = [...allSlugsInEmails]
	const slugToData = new Map<
		string,
		{
			id: string | null
			url: string
			shortlinkClicks: number
			signups: number
			purchases: number
			revenue: number
		}
	>()

	if (slugList.length > 0) {
		const shortlinkRows = await db
			.select({ id: shortlink.id, slug: shortlink.slug, url: shortlink.url })
			.from(shortlink)
			.where(
				sql`${shortlink.slug} IN (${sql.join(
					slugList.map((s) => sql`${s}`),
					sql`, `,
				)})`,
			)

		const idToSlug = new Map<string, string>()
		for (const row of shortlinkRows) {
			idToSlug.set(row.id, row.slug)
			slugToData.set(row.slug, {
				id: row.id,
				url: row.url,
				shortlinkClicks: 0,
				signups: 0,
				purchases: 0,
				revenue: 0,
			})
		}
		for (const slug of slugList) {
			if (!slugToData.has(slug)) {
				slugToData.set(slug, {
					id: null,
					url: `https://www.aihero.dev/s/${slug}`,
					shortlinkClicks: 0,
					signups: 0,
					purchases: 0,
					revenue: 0,
				})
			}
		}

		const shortlinkIds = shortlinkRows.map((r) => r.id)
		if (shortlinkIds.length > 0) {
			const clickConditions = [
				sql`${shortlinkClick.shortlinkId} IN (${sql.join(
					shortlinkIds.map((id) => sql`${id}`),
					sql`, `,
				)})`,
			]
			if (since) clickConditions.push(gte(shortlinkClick.timestamp, since))

			const clickRows = await db
				.select({ shortlinkId: shortlinkClick.shortlinkId, count: count() })
				.from(shortlinkClick)
				.where(and(...clickConditions))
				.groupBy(shortlinkClick.shortlinkId)

			for (const clickRow of clickRows) {
				const slug = idToSlug.get(clickRow.shortlinkId)
				if (!slug) continue
				const data = slugToData.get(slug)
				if (!data) continue
				data.shortlinkClicks = clickRow.count
			}

			const signupRows = await db
				.select({
					shortlinkId: shortlinkAttribution.shortlinkId,
					count: count(),
				})
				.from(shortlinkAttribution)
				.where(
					and(
						sql`${shortlinkAttribution.shortlinkId} IN (${sql.join(
							shortlinkIds.map((id) => sql`${id}`),
							sql`, `,
						)})`,
						eq(shortlinkAttribution.type, 'signup'),
						...(since ? [gte(shortlinkAttribution.createdAt, since)] : []),
					),
				)
				.groupBy(shortlinkAttribution.shortlinkId)

			for (const signupRow of signupRows) {
				const slug = idToSlug.get(signupRow.shortlinkId)
				if (!slug) continue
				const data = slugToData.get(slug)
				if (!data) continue
				data.signups = signupRow.count
			}
		}

		const slugExpr = sql<string>`COALESCE(
			NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.attribution.shortlink.slug')), 'null'),
			NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.shortlinkRef')), 'null')
		)`
		const purchaseConditions = [
			inArray(purchases.status, [...PAID_STATUSES]),
			sql`${purchases.totalAmount} > 0`,
			sql`${slugExpr} IN (${sql.join(
				slugList.map((slug) => sql`${slug}`),
				sql`, `,
			)})`,
		]
		if (since) purchaseConditions.push(gte(purchases.createdAt, since))
		if (filters.productId)
			purchaseConditions.push(eq(purchases.productId, filters.productId))

		const purchaseRows = await db
			.select({
				slug: slugExpr.as('slug'),
				purchases: count(),
				revenue: sum(purchases.totalAmount),
			})
			.from(purchases)
			.where(and(...purchaseConditions))
			.groupBy(slugExpr)

		for (const purchaseRow of purchaseRows) {
			if (!purchaseRow.slug) continue
			const data = slugToData.get(purchaseRow.slug)
			if (!data) continue
			data.purchases = purchaseRow.purchases
			data.revenue = Number(purchaseRow.revenue ?? 0)
		}
	}

	const campaigns: EmailCampaignFunnel[] = filtered.map((b) => {
		const kitLinks = b.clicks.map((click) => {
			const match = click.url.match(shortlinkPattern)
			return {
				url: click.url,
				uniqueClicks: click.uniqueClicks,
				clickToDeliveryRate: click.clickToDeliveryRate,
				clickToOpenRate: click.clickToOpenRate,
				shortlinkSlug: match?.[1] ?? null,
			}
		})

		const shortlinks = b.clicks
			.map((click) => {
				const match = click.url.match(shortlinkPattern)
				if (!match) return null
				const slug = match[1]!
				const data = slugToData.get(slug)
				return {
					slug,
					url: data?.url ?? click.url,
					kitClicks: click.uniqueClicks,
					clickToDeliveryRate: click.clickToDeliveryRate,
					clickToOpenRate: click.clickToOpenRate,
					shortlinkClicks: data?.shortlinkClicks ?? 0,
					signups: data?.signups ?? 0,
					purchases: data?.purchases ?? 0,
					revenue: data?.revenue ?? 0,
				}
			})
			.filter(Boolean) as EmailCampaignFunnel['shortlinks']

		const totalSignups = shortlinks.reduce((s, l) => s + l.signups, 0)
		const totalPurchases = shortlinks.reduce((s, l) => s + l.purchases, 0)
		const totalRevenue = shortlinks.reduce((s, l) => s + l.revenue, 0)
		const totalKitClicks = shortlinks.reduce((s, l) => s + l.kitClicks, 0)

		return {
			broadcastId: b.id,
			subject: b.subject,
			sentAt: b.sentAt,
			recipients: b.stats.recipients,
			openRate: b.stats.openRate,
			emailsOpened: b.stats.emailsOpened,
			clickRate: b.stats.clickRate,
			totalClicks: b.stats.totalClicks,
			showTotalClicks: b.stats.showTotalClicks,
			unsubscribes: b.stats.unsubscribes,
			unsubscribeRate: b.stats.unsubscribeRate,
			progress: b.stats.progress,
			openTrackingDisabled: b.stats.openTrackingDisabled,
			clickTrackingDisabled: b.stats.clickTrackingDisabled,
			kitLinks,
			shortlinks,
			totalSignups,
			totalPurchases,
			totalRevenue,
			clickToPurchaseRate:
				totalKitClicks > 0 ? totalPurchases / totalKitClicks : 0,
		}
	})

	return {
		configured: true,
		totalBroadcasts: campaigns.length,
		totalRecipients: campaigns.reduce((s, c) => s + c.recipients, 0),
		totalRevenue: campaigns.reduce((s, c) => s + c.totalRevenue, 0),
		campaigns: campaigns.sort((a, b) => b.totalRevenue - a.totalRevenue),
	}
}
