import { db } from '@/db'
import {
	coupon,
	products,
	purchases,
	resourceProgress,
	shortlink,
	shortlinkAttribution,
	shortlinkClick,
	users,
} from '@/db/schema'
import {
	and,
	count,
	desc,
	eq,
	gt,
	gte,
	inArray,
	lte,
	sql,
	sum,
} from 'drizzle-orm'

// ─── Types ───────────────────────────────────────────────────────────────────

export type AnalyticsTimeRange = '24h' | '7d' | '30d' | '90d' | 'all'

/** Valid + Restricted = all paid, delivered purchases (matches Stripe gross revenue). */
const PAID_STATUSES = ['Valid', 'Restricted'] as const
const paidPurchase = () => inArray(purchases.status, [...PAID_STATUSES])

function rangeToDate(range: AnalyticsTimeRange): Date | null {
	if (range === 'all') return null
	const now = new Date()
	const hours: Record<string, number> = {
		'24h': 24,
		'7d': 7 * 24,
		'30d': 30 * 24,
		'90d': 90 * 24,
	}
	return new Date(now.getTime() - (hours[range] ?? 30 * 24) * 60 * 60 * 1000)
}

// ─── Revenue ─────────────────────────────────────────────────────────────────

export async function getRevenueSummary(range: AnalyticsTimeRange = '30d') {
	const since = rangeToDate(range)
	const conditions = [paidPurchase()]
	if (since) conditions.push(gte(purchases.createdAt, since))

	const [totals] = await db
		.select({
			totalRevenue: sum(purchases.totalAmount),
			purchaseCount: count(),
		})
		.from(purchases)
		.where(and(...conditions))

	return {
		totalRevenue: Number(totals?.totalRevenue ?? 0),
		purchaseCount: totals?.purchaseCount ?? 0,
		avgOrderValue:
			totals?.purchaseCount && totals.purchaseCount > 0
				? Number(totals.totalRevenue ?? 0) / totals.purchaseCount
				: 0,
	}
}

export async function getRevenueByDay(range: AnalyticsTimeRange = '30d') {
	const since = rangeToDate(range)
	const conditions = [paidPurchase()]
	if (since) conditions.push(gte(purchases.createdAt, since))

	const rows = await db
		.select({
			date: sql<string>`DATE(${purchases.createdAt})`.as('date'),
			revenue: sum(purchases.totalAmount),
			count: count(),
		})
		.from(purchases)
		.where(and(...conditions))
		.groupBy(sql`DATE(${purchases.createdAt})`)
		.orderBy(sql`DATE(${purchases.createdAt})`)

	return rows.map((r) => ({
		date: r.date,
		revenue: Number(r.revenue ?? 0),
		count: r.count,
	}))
}

/**
 * Revenue by day for the previous period of equal length.
 * E.g., if range = '30d', returns the 30 days before those 30 days.
 * Returns data with a `dayOffset` (0 = start of period) for overlay alignment.
 */
export async function getPreviousPeriodRevenueByDay(
	range: AnalyticsTimeRange = '30d',
) {
	if (range === 'all') return []

	const hours: Record<string, number> = {
		'24h': 24,
		'7d': 7 * 24,
		'30d': 30 * 24,
		'90d': 90 * 24,
	}
	const periodMs = (hours[range] ?? 30 * 24) * 60 * 60 * 1000
	const now = new Date()
	const periodStart = new Date(now.getTime() - periodMs)
	const prevStart = new Date(periodStart.getTime() - periodMs)

	const rows = await db
		.select({
			date: sql<string>`DATE(${purchases.createdAt})`.as('date'),
			revenue: sum(purchases.totalAmount),
			count: count(),
		})
		.from(purchases)
		.where(
			and(
				paidPurchase(),
				gte(purchases.createdAt, prevStart),
				lte(purchases.createdAt, periodStart),
			),
		)
		.groupBy(sql`DATE(${purchases.createdAt})`)
		.orderBy(sql`DATE(${purchases.createdAt})`)

	return rows.map((r) => ({
		date: r.date,
		revenue: Number(r.revenue ?? 0),
		count: r.count,
	}))
}

export async function getRevenueByProduct(range: AnalyticsTimeRange = '30d') {
	const since = rangeToDate(range)
	const conditions = [paidPurchase()]
	if (since) conditions.push(gte(purchases.createdAt, since))

	const rows = await db
		.select({
			productId: purchases.productId,
			productName: products.name,
			revenue: sum(purchases.totalAmount),
			count: count(),
		})
		.from(purchases)
		.leftJoin(products, eq(purchases.productId, products.id))
		.where(and(...conditions))
		.groupBy(purchases.productId, products.name)
		.orderBy(desc(sum(purchases.totalAmount)))

	return rows.map((r) => ({
		productId: r.productId,
		productName: r.productName ?? '(unknown)',
		revenue: Number(r.revenue ?? 0),
		count: r.count,
	}))
}

export async function getRevenueByCountry(range: AnalyticsTimeRange = '30d') {
	const since = rangeToDate(range)
	const conditions = [paidPurchase()]
	if (since) conditions.push(gte(purchases.createdAt, since))

	const rows = await db
		.select({
			country: purchases.country,
			revenue: sum(purchases.totalAmount),
			count: count(),
		})
		.from(purchases)
		.where(and(...conditions))
		.groupBy(purchases.country)
		.orderBy(desc(sum(purchases.totalAmount)))
		.limit(20)

	return rows.map((r) => ({
		country: r.country ?? '(unknown)',
		revenue: Number(r.revenue ?? 0),
		count: r.count,
	}))
}

export async function getRecentPurchases(
	limit: number = 20,
	filter: 'all' | 'team' | 'individual' = 'all',
	range: AnalyticsTimeRange = 'all',
) {
	const since = rangeToDate(range)
	const conditions = [paidPurchase()]
	if (since) conditions.push(gte(purchases.createdAt, since))

	if (filter === 'team') {
		// Multi-seat purchases: join coupon to filter seats > 1, sort by amount
		conditions.push(sql`${purchases.bulkCouponId} IS NOT NULL`)

		const rows = await db
			.select({
				id: purchases.id,
				createdAt: purchases.createdAt,
				totalAmount: purchases.totalAmount,
				productName: products.name,
				productId: purchases.productId,
				country: purchases.country,
				couponId: purchases.couponId,
				userId: purchases.userId,
				userName: users.name,
				userEmail: users.email,
				organizationId: purchases.organizationId,
				seats: coupon.maxUses,
			})
			.from(purchases)
			.leftJoin(products, eq(purchases.productId, products.id))
			.leftJoin(users, eq(purchases.userId, users.id))
			.leftJoin(coupon, eq(purchases.bulkCouponId, coupon.id))
			.where(and(...conditions, gt(coupon.maxUses, 1)))
			.orderBy(desc(purchases.totalAmount))
			.limit(limit)

		return rows.map((r) => ({
			id: r.id,
			createdAt: r.createdAt,
			totalAmount: Number(r.totalAmount),
			productName: r.productName ?? '(unknown)',
			productId: r.productId,
			country: r.country,
			couponId: r.couponId,
			userName: r.userName ?? null,
			userEmail: r.userEmail ?? null,
			isTeam: true,
			seats: r.seats ?? null,
		}))
	}

	if (filter === 'individual') {
		conditions.push(sql`${purchases.bulkCouponId} IS NULL`)
	}

	const rows = await db.query.purchases.findMany({
		where: and(...conditions),
		orderBy: [desc(purchases.totalAmount)],
		limit,
		with: {
			product: true,
			user: true,
		},
	})

	return rows.map((r) => ({
		id: r.id,
		createdAt: r.createdAt,
		totalAmount: Number(r.totalAmount),
		productName: r.product?.name ?? '(unknown)',
		productId: r.productId,
		country: r.country,
		couponId: r.couponId,
		userName: r.user?.name ?? null,
		userEmail: r.user?.email ?? null,
		isTeam: r.organizationId != null,
		seats: null as number | null,
	}))
}

// ─── Attribution ─────────────────────────────────────────────────────────────

export async function getAttributionSummary(range: AnalyticsTimeRange = '30d') {
	const since = rangeToDate(range)
	const conditions: ReturnType<typeof eq>[] = []
	if (since) conditions.push(gte(shortlinkAttribution.createdAt, since))

	const rows = await db
		.select({
			type: shortlinkAttribution.type,
			count: count(),
		})
		.from(shortlinkAttribution)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.groupBy(shortlinkAttribution.type)

	return rows.map((r) => ({
		type: r.type,
		count: r.count,
	}))
}

export async function getShortlinkPerformance(
	range: AnalyticsTimeRange = '30d',
) {
	const since = rangeToDate(range)
	const clickConditions: ReturnType<typeof eq>[] = []
	if (since) clickConditions.push(gte(shortlinkClick.timestamp, since))

	const rows = await db
		.select({
			shortlinkId: shortlinkClick.shortlinkId,
			slug: shortlink.slug,
			url: shortlink.url,
			clicks: count(),
		})
		.from(shortlinkClick)
		.innerJoin(shortlink, eq(shortlinkClick.shortlinkId, shortlink.id))
		.where(clickConditions.length > 0 ? and(...clickConditions) : undefined)
		.groupBy(shortlinkClick.shortlinkId, shortlink.slug, shortlink.url)
		.orderBy(desc(count()))
		.limit(20)

	// Get attribution counts per shortlink
	const attrConditions: ReturnType<typeof eq>[] = []
	if (since) attrConditions.push(gte(shortlinkAttribution.createdAt, since))

	const attrRows = await db
		.select({
			shortlinkId: shortlinkAttribution.shortlinkId,
			type: shortlinkAttribution.type,
			count: count(),
		})
		.from(shortlinkAttribution)
		.where(attrConditions.length > 0 ? and(...attrConditions) : undefined)
		.groupBy(shortlinkAttribution.shortlinkId, shortlinkAttribution.type)

	const attrMap = new Map<string, { signups: number; purchases: number }>()
	for (const a of attrRows) {
		const existing = attrMap.get(a.shortlinkId) ?? { signups: 0, purchases: 0 }
		if (a.type === 'signup') existing.signups = a.count
		if (a.type === 'purchase') existing.purchases = a.count
		attrMap.set(a.shortlinkId, existing)
	}

	return rows.map((r) => {
		const attr = attrMap.get(r.shortlinkId)
		return {
			shortlinkId: r.shortlinkId,
			slug: r.slug,
			url: r.url,
			clicks: r.clicks,
			signups: attr?.signups ?? 0,
			purchases: attr?.purchases ?? 0,
		}
	})
}

// ─── Revenue Attribution ──────────────────────────────────────────────────────

export async function getRevenueBySource(range: AnalyticsTimeRange = '30d') {
	const since = rangeToDate(range)
	const conditions = [paidPurchase()]
	if (since) conditions.push(gte(purchases.createdAt, since))

	const sourceExpr = sql<string>`COALESCE(
		NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.attribution.utm.source')), 'null'),
		NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.utmSource')), 'null'),
		CASE
			WHEN JSON_EXTRACT(${purchases.fields}, '$.attribution.shortlink.slug') IS NOT NULL THEN 'shortlink'
			WHEN JSON_EXTRACT(${purchases.fields}, '$.attribution.selfReportedSource') IS NOT NULL THEN 'self_reported'
			WHEN JSON_EXTRACT(${purchases.fields}, '$.attribution.ga.clientId') IS NOT NULL THEN 'ga4'
			WHEN JSON_EXTRACT(${purchases.fields}, '$.gaClientId') IS NOT NULL THEN 'ga4'
			ELSE NULL
		END
	)`
	const mediumExpr = sql<string>`COALESCE(
		NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.attribution.utm.medium')), 'null'),
		NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.utmMedium')), 'null'),
		CASE
			WHEN JSON_EXTRACT(${purchases.fields}, '$.attribution.shortlink.slug') IS NOT NULL THEN 'shortlink'
			WHEN JSON_EXTRACT(${purchases.fields}, '$.attribution.selfReportedSource') IS NOT NULL THEN 'checkout_survey'
			WHEN JSON_EXTRACT(${purchases.fields}, '$.attribution.ga.clientId') IS NOT NULL THEN 'client_id'
			WHEN JSON_EXTRACT(${purchases.fields}, '$.gaClientId') IS NOT NULL THEN 'client_id'
			ELSE NULL
		END
	)`
	const campaignExpr = sql<string>`COALESCE(
		NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.attribution.utm.campaign')), 'null'),
		NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.utmCampaign')), 'null'),
		NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.attribution.shortlink.slug')), 'null'),
		NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.attribution.selfReportedSource')), 'null')
	)`

	const rows = await db
		.select({
			source: sourceExpr.as('source'),
			medium: mediumExpr.as('medium'),
			campaign: campaignExpr.as('campaign'),
			revenue: sum(purchases.totalAmount),
			count: count(),
		})
		.from(purchases)
		.where(and(...conditions))
		.groupBy(sourceExpr, mediumExpr, campaignExpr)
		.orderBy(desc(sum(purchases.totalAmount)))

	return rows.map((r) => ({
		source: r.source ?? null,
		medium: r.medium ?? null,
		campaign: r.campaign ?? null,
		revenue: Number(r.revenue ?? 0),
		count: r.count,
	}))
}

export async function getConversionFunnel(range: AnalyticsTimeRange = '30d') {
	const since = rangeToDate(range)

	const userConditions = since ? [gte(users.createdAt, since)] : []
	const purchaseConditions = [paidPurchase()]
	if (since) purchaseConditions.push(gte(purchases.createdAt, since))

	const [userCount] = await db
		.select({ total: count() })
		.from(users)
		.where(userConditions.length > 0 ? and(...userConditions) : undefined)

	const [purchaseCount] = await db
		.select({ total: count() })
		.from(purchases)
		.where(and(...purchaseConditions))

	const [attributedCount] = await db
		.select({ total: count() })
		.from(purchases)
		.where(
			and(
				...purchaseConditions,
				sql`(
          JSON_EXTRACT(${purchases.fields}, '$.attribution') IS NOT NULL
          OR JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.utmSource')) IS NOT NULL
          OR JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.gaClientId')) IS NOT NULL
        )`,
			),
		)

	const totalSignups = userCount?.total ?? 0
	const totalPurchases = purchaseCount?.total ?? 0
	const attributedPurchases = attributedCount?.total ?? 0

	return {
		totalSignups,
		totalPurchases,
		attributedPurchases,
		conversionRate: totalSignups > 0 ? totalPurchases / totalSignups : 0,
		attributionCoverage:
			totalPurchases > 0 ? attributedPurchases / totalPurchases : 0,
	}
}

export async function getAttributedRevenueSummary(
	range: AnalyticsTimeRange = '30d',
) {
	const since = rangeToDate(range)
	const conditions = [paidPurchase()]
	if (since) conditions.push(gte(purchases.createdAt, since))

	const [totals] = await db
		.select({ total: sum(purchases.totalAmount), count: count() })
		.from(purchases)
		.where(and(...conditions))

	const [attributed] = await db
		.select({ total: sum(purchases.totalAmount) })
		.from(purchases)
		.where(
			and(
				...conditions,
				sql`(
          JSON_EXTRACT(${purchases.fields}, '$.attribution') IS NOT NULL
          OR JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.utmSource')) IS NOT NULL
          OR JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.gaClientId')) IS NOT NULL
        )`,
			),
		)

	const totalRevenue = Number(totals?.total ?? 0)
	const attributedRevenue = Number(attributed?.total ?? 0)
	const unattributedRevenue = totalRevenue - attributedRevenue
	const totalPurchases = totals?.count ?? 0

	return {
		totalRevenue,
		attributedRevenue,
		unattributedRevenue,
		attributionRate: totalRevenue > 0 ? attributedRevenue / totalRevenue : 0,
		totalPurchases,
	}
}

export async function getContentPurchaseCorrelation(
	range: AnalyticsTimeRange = '30d',
	limit: number = 20,
) {
	const since = rangeToDate(range)
	const purchaseConditions = [paidPurchase()]
	if (since) purchaseConditions.push(gte(purchases.createdAt, since))

	const purchaserRows = await db
		.selectDistinct({ userId: purchases.userId })
		.from(purchases)
		.where(and(...purchaseConditions))

	const purchaserIds = purchaserRows
		.map((r) => r.userId)
		.filter((id): id is string => id !== null)

	if (purchaserIds.length === 0) return []

	const rows = await db
		.select({
			resourceId: resourceProgress.resourceId,
			purchaserCount: count(),
		})
		.from(resourceProgress)
		.where(
			sql`${resourceProgress.userId} IN (${sql.join(
				purchaserIds.map((id) => sql`${id}`),
				sql`, `,
			)})`,
		)
		.groupBy(resourceProgress.resourceId)
		.orderBy(desc(count()))
		.limit(limit)

	return rows.map((r) => ({
		resourceId: r.resourceId,
		purchaserCount: r.purchaserCount,
	}))
}

// ─── Attribution Trail Lookup ─────────────────────────────────────────────────

export interface AttributionTrailEvent {
	type: 'click' | 'signup' | 'progress' | 'purchase'
	timestamp: Date
	detail: Record<string, any>
}

export interface AttributionTrail {
	user: {
		id: string
		email: string | null
		name: string | null
		createdAt: Date
	} | null
	events: AttributionTrailEvent[]
	purchases: {
		id: string
		totalAmount: number
		productName: string
		createdAt: Date
		country: string | null
		utmSource: string | null
		utmMedium: string | null
		utmCampaign: string | null
	}[]
}

/**
 * Trace the full attribution journey for a user by email or purchaseId.
 * Walks: ShortlinkClick → ShortlinkAttribution (signup) → ResourceProgress → Purchase
 */
export async function traceAttribution(opts: {
	email?: string
	purchaseId?: string
}): Promise<AttributionTrail> {
	const events: AttributionTrailEvent[] = []

	// Resolve user
	let userId: string | null = null
	let userEmail: string | null = opts.email ?? null
	let userRecord: AttributionTrail['user'] = null

	if (opts.purchaseId) {
		const [purchase] = await db
			.select({
				userId: purchases.userId,
				email: users.email,
			})
			.from(purchases)
			.leftJoin(users, eq(purchases.userId, users.id))
			.where(eq(purchases.id, opts.purchaseId))
			.limit(1)
		userId = purchase?.userId ?? null
		userEmail = purchase?.email ?? userEmail
	}

	if (userEmail && !userId) {
		const [u] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, userEmail))
			.limit(1)
		userId = u?.id ?? null
	}

	if (userId) {
		const [u] = await db
			.select({
				id: users.id,
				email: users.email,
				name: users.name,
				createdAt: users.createdAt,
			})
			.from(users)
			.where(eq(users.id, userId))
			.limit(1)
		userRecord = u
			? {
					id: u.id,
					email: u.email,
					name: u.name ?? null,
					createdAt: u.createdAt!,
				}
			: null
	}

	// Find shortlink attributions for this user (by userId or email)
	const attrConditions = []
	if (userId) attrConditions.push(eq(shortlinkAttribution.userId, userId))
	if (userEmail) attrConditions.push(eq(shortlinkAttribution.email, userEmail))

	if (attrConditions.length > 0) {
		const attrs = await db
			.select({
				type: shortlinkAttribution.type,
				createdAt: shortlinkAttribution.createdAt,
				metadata: shortlinkAttribution.metadata,
				shortlinkId: shortlinkAttribution.shortlinkId,
				slug: shortlink.slug,
				url: shortlink.url,
			})
			.from(shortlinkAttribution)
			.leftJoin(shortlink, eq(shortlinkAttribution.shortlinkId, shortlink.id))
			.where(sql`(${sql.join(attrConditions, sql` OR `)})`)
			.orderBy(shortlinkAttribution.createdAt)

		for (const attr of attrs) {
			// Find clicks on this shortlink before the attribution event
			const clicks = await db
				.select({
					timestamp: shortlinkClick.timestamp,
					referrer: shortlinkClick.referrer,
					country: shortlinkClick.country,
					device: shortlinkClick.device,
				})
				.from(shortlinkClick)
				.where(
					and(
						eq(shortlinkClick.shortlinkId, attr.shortlinkId),
						lte(shortlinkClick.timestamp, attr.createdAt),
					),
				)
				.orderBy(desc(shortlinkClick.timestamp))
				.limit(3) // last 3 clicks before attribution

			for (const click of clicks) {
				events.push({
					type: 'click',
					timestamp: click.timestamp,
					detail: {
						shortlink: `/s/${attr.slug}`,
						destination: attr.url,
						referrer: click.referrer,
						country: click.country,
						device: click.device,
					},
				})
			}

			events.push({
				type: attr.type === 'purchase' ? 'purchase' : 'signup',
				timestamp: attr.createdAt,
				detail: {
					shortlink: `/s/${attr.slug}`,
					metadata: attr.metadata ? JSON.parse(attr.metadata) : null,
				},
			})
		}
	}

	// Find resource progress for this user
	if (userId) {
		const progress = await db
			.select({
				resourceId: resourceProgress.resourceId,
				completedAt: resourceProgress.completedAt,
				createdAt: resourceProgress.createdAt,
			})
			.from(resourceProgress)
			.where(eq(resourceProgress.userId, userId))
			.orderBy(resourceProgress.createdAt)
			.limit(20) // cap at 20 most recent

		for (const p of progress) {
			events.push({
				type: 'progress',
				timestamp: p.completedAt ?? p.createdAt,
				detail: { resourceId: p.resourceId },
			})
		}
	}

	// Find purchases
	const purchaseConditions = [paidPurchase()]
	if (opts.purchaseId) {
		purchaseConditions.push(eq(purchases.id, opts.purchaseId))
	} else if (userId) {
		purchaseConditions.push(eq(purchases.userId, userId))
	} else {
		// No user found, return empty
		return { user: userRecord, events: [], purchases: [] }
	}

	const purchaseRows = await db
		.select({
			id: purchases.id,
			totalAmount: purchases.totalAmount,
			productName: products.name,
			createdAt: purchases.createdAt,
			country: purchases.country,
			fields: purchases.fields,
		})
		.from(purchases)
		.leftJoin(products, eq(purchases.productId, products.id))
		.where(and(...purchaseConditions))
		.orderBy(purchases.createdAt)

	const purchaseResults = purchaseRows.map((p) => {
		const fields = (p.fields as Record<string, any>) ?? {}
		events.push({
			type: 'purchase',
			timestamp: p.createdAt,
			detail: {
				purchaseId: p.id,
				amount: Number(p.totalAmount),
				product: p.productName,
			},
		})
		return {
			id: p.id,
			totalAmount: Number(p.totalAmount),
			productName: p.productName ?? 'Unknown',
			createdAt: p.createdAt,
			country: p.country,
			utmSource: fields.utmSource ?? null,
			utmMedium: fields.utmMedium ?? null,
			utmCampaign: fields.utmCampaign ?? null,
		}
	})

	// Sort all events by timestamp
	events.sort(
		(a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
	)

	return { user: userRecord, events, purchases: purchaseResults }
}
