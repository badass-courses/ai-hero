import { Suspense } from 'react'
import { unstable_cache } from 'next/cache'
import { notFound } from 'next/navigation'
import { query, type AnalyticsRange } from '@/lib/analytics'
import {
	getAttributionSummary,
	getPreviousPeriodRevenueByDay,
	getRecentPurchases,
	getRevenueByCountry,
	getRevenueByDay,
	getRevenueByProduct,
	getRevenueSummary,
	getShortlinkPerformance,
} from '@/lib/analytics/providers/database'
import {
	getVideoDashboardData,
	getVideoThumbnails,
	type TimeRange,
} from '@/lib/mux-data'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { Loader2 } from 'lucide-react'

import { OmnibusDashboard } from './_components/omnibus-dashboard'

// ─── Cached data fetchers (tiered by volatility) ────────────────────────────

// Hot (2 min) — changes with every purchase
const cachedRevenueSummary = unstable_cache(
	(range: string) => getRevenueSummary(range as any),
	['analytics-revenue-summary'],
	{ revalidate: 120 },
)
const cachedRecentPurchases = unstable_cache(
	(limit: number, filter: string, range: string) =>
		getRecentPurchases(limit, filter as any, range as any),
	['analytics-recent-purchases'],
	{ revalidate: 120 },
)

// Warm (5 min) — changes daily or with shortlink clicks
const cachedRevenueByDay = unstable_cache(
	(range: string) => getRevenueByDay(range as any),
	['analytics-revenue-daily'],
	{ revalidate: 300 },
)
const cachedRevenueByProduct = unstable_cache(
	(range: string) => getRevenueByProduct(range as any),
	['analytics-revenue-products'],
	{ revalidate: 300 },
)
const cachedRevenueByCountry = unstable_cache(
	(range: string) => getRevenueByCountry(range as any),
	['analytics-revenue-countries'],
	{ revalidate: 300 },
)
const cachedAttribution = unstable_cache(
	(range: string) => getAttributionSummary(range as any),
	['analytics-attribution'],
	{ revalidate: 300 },
)
const cachedShortlinks = unstable_cache(
	(range: string) => getShortlinkPerformance(range as any),
	['analytics-shortlinks-v2'],
	{ revalidate: 300 },
)
const cachedCoverage = unstable_cache(
	(range: string) => query('attribution/coverage', { range: range as any }),
	['analytics-coverage'],
	{ revalidate: 300 },
)
const cachedSurveySegments = unstable_cache(
	(range: string) => query('surveys/questions', { range: range as any }),
	['analytics-survey-segments'],
	{ revalidate: 300 },
)
const cachedSurveyCorrelation = unstable_cache(
	(range: string) =>
		query('correlation/survey-revenue', { range: range as any }),
	['analytics-survey-correlation'],
	{ revalidate: 300 },
)
const cachedValuePaths = unstable_cache(
	(range: string) => query('value-paths/summary', { range: range as any }),
	['analytics-value-paths'],
	{ revalidate: 300 },
)

// Cool (30 min) — GA4 has processing delay, Mux already caches internally
const cachedTraffic = unstable_cache(
	(range: string) => query('traffic', { range: range as any }),
	['analytics-traffic'],
	{ revalidate: 1800 },
)
const cachedMux = unstable_cache(
	(timeRange: string) => getVideoDashboardData(timeRange as any),
	['analytics-mux'],
	{ revalidate: 1800 },
)

// Cold (6 hrs) — previous period is historical
const cachedPreviousPeriod = unstable_cache(
	(range: string) => getPreviousPeriodRevenueByDay(range as any),
	['analytics-prev-period'],
	{ revalidate: 21600 },
)
const cachedThumbnails = unstable_cache(
	(timeRange: string, limit: number) =>
		getVideoThumbnails(timeRange as any, limit),
	['analytics-mux-thumbnails'],
	{ revalidate: 21600 },
)

function extractData<T>(result: { ok: boolean; data?: T } | null): T | null {
	if (!result || !result.ok) return null
	return result.data ?? null
}

const VALID_RANGES = new Set(['24h', '7d', '30d', '90d', 'all'])

function parseRange(raw?: string): AnalyticsRange {
	if (raw && VALID_RANGES.has(raw)) return raw as AnalyticsRange
	return '30d'
}

function toMuxRange(range: AnalyticsRange): TimeRange {
	if (range === '7d') return '7:days'
	if (range === '90d') return '90:days'
	return '30:days'
}

async function DashboardContent({ range }: { range: AnalyticsRange }) {
	// All fetches run in parallel via Promise.all — cached at different TTLs
	const [
		// Hot (2min cache) — changes with every purchase
		summary,
		recentPurchases,
		// Warm (5min cache) — daily/periodic updates
		daily,
		byProduct,
		byCountry,
		attribution,
		shortlinks,
		coverageResult,
		surveySegmentsResult,
		surveyCorrelationResult,
		valuePathsResult,
		// Cool (30min cache) — GA4/Mux have processing delay
		trafficResult,
		muxData,
		// Cold (6hr cache) — previous period baseline
		previousDaily,
	] = await Promise.all([
		cachedRevenueSummary(range),
		cachedRecentPurchases(20, 'team', range),
		cachedRevenueByDay(range),
		cachedRevenueByProduct(range),
		cachedRevenueByCountry(range),
		cachedAttribution(range),
		cachedShortlinks(range),
		cachedCoverage(range).catch(() => null),
		cachedSurveySegments(range).catch(() => null),
		cachedSurveyCorrelation(range).catch(() => null),
		cachedValuePaths(range).catch(() => null),
		cachedTraffic(range).catch(() => null),
		cachedMux(toMuxRange(range)).catch(() => null),
		cachedPreviousPeriod(range),
	])

	// Thumbnails: cold cache, resolved via video_id → playbackId
	const muxThumbnails = muxData
		? await cachedThumbnails(toMuxRange(range), 10).catch(() => ({}))
		: ({} as Record<string, string>)

	return (
		<OmnibusDashboard
			appName="AI Hero"
			data={{
				summary,
				daily,
				previousDaily,
				byProduct,
				byCountry,
				recentPurchases,
				attribution,
				shortlinks,
				traffic: extractData(trafficResult),
				attributionCoverage: extractData(coverageResult),
				surveySegments: extractData(surveySegmentsResult),
				surveyCorrelation: extractData(surveyCorrelationResult),
				valuePaths: extractData(valuePathsResult),
				mux: muxData,
				muxThumbnails: muxThumbnails as Record<string, string>,
			}}
			initialRange={range}
			surveyDrilldownHref="/admin/analytics/surveys"
		/>
	)
}

function DashboardSkeleton() {
	return (
		<div className="flex flex-col gap-5 py-6 lg:gap-7">
			{/* Header skeleton */}
			<div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
				<div className="space-y-2">
					<div className="bg-muted h-7 w-32 animate-pulse rounded" />
					<div className="bg-muted/60 h-4 w-56 animate-pulse rounded" />
				</div>
				<div className="bg-muted h-8 w-48 animate-pulse rounded-lg" />
			</div>
			{/* Stat grid skeleton */}
			<div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3 xl:grid-cols-5">
				{Array.from({ length: 5 }).map((_, i) => (
					<div key={i} className="border-border/50 rounded-xl border p-4">
						<div className="bg-muted/60 mb-2 h-3 w-16 animate-pulse rounded" />
						<div className="bg-muted mb-1 h-6 w-20 animate-pulse rounded" />
						<div className="bg-muted/40 h-3 w-28 animate-pulse rounded" />
					</div>
				))}
			</div>
			{/* Video cards skeleton */}
			<div className="grid gap-3 md:grid-cols-2">
				{Array.from({ length: 2 }).map((_, i) => (
					<div key={i} className="border-border/50 rounded-xl border p-5">
						<div className="bg-muted mb-4 h-5 w-24 animate-pulse rounded" />
						{Array.from({ length: 3 }).map((_, j) => (
							<div key={j} className="mb-3 flex items-center gap-3">
								<div className="bg-muted h-10 w-[72px] animate-pulse rounded" />
								<div className="flex-1 space-y-2">
									<div className="bg-muted h-4 w-3/4 animate-pulse rounded" />
									<div className="bg-muted/60 h-3 w-1/2 animate-pulse rounded" />
								</div>
							</div>
						))}
					</div>
				))}
			</div>
			{/* Chart skeleton */}
			<div className="border-border/50 rounded-xl border p-5">
				<div className="bg-muted mb-4 h-5 w-28 animate-pulse rounded" />
				<div className="bg-muted/30 h-[280px] w-full animate-pulse rounded" />
			</div>
			{/* Loading indicator */}
			<div className="flex items-center justify-center gap-2 py-4">
				<Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
				<span className="text-muted-foreground text-xs">
					Loading revenue · attribution · site video · traffic…
				</span>
			</div>
		</div>
	)
}

export default async function AnalyticsPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
	const { ability, session } = await getServerAuthSession()
	const canManage = ability.can('manage', 'all')
	const canViewAnalytics = ability.can('view', 'Analytics')

	if (!canManage && !canViewAnalytics) {
		await log.warn('admin.analytics.access-denied', {
			userId: session?.user?.id ?? null,
			email: (session?.user as any)?.email ?? null,
			roles: (session?.user as any)?.roles?.map((r: any) => r.name) ?? [],
			canManage,
			canViewAnalytics,
			authenticated: !!session?.user,
			abilityRules: JSON.stringify(ability.rules),
		})
		notFound()
	}

	const params = await searchParams
	const range = parseRange(
		Array.isArray(params.range) ? params.range[0] : params.range,
	)

	void log.info('admin.analytics.page-load', {
		userId: session?.user?.id ?? null,
		email: (session?.user as any)?.email ?? null,
		roles: (session?.user as any)?.roles?.map((r: any) => r.name) ?? [],
		range,
		canManage,
		canViewAnalytics,
	})

	return (
		<main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 px-3 py-6 sm:px-4 sm:py-10 lg:gap-10">
			<Suspense fallback={<DashboardSkeleton />}>
				<DashboardContent range={range} />
			</Suspense>
		</main>
	)
}
