import { unstable_cache } from 'next/cache'
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
	getAttributedRevenueSummary,
} from '@/lib/analytics/providers/database'
import {
	getVideoDashboardData,
	getVideoThumbnails,
	type TimeRange,
} from '@/lib/mux-data'

import {
	DASHBOARD_SECTIONS,
	type DashboardSection,
	type DashboardSectionData,
} from './dashboard-contract'

const cachedRevenueSummary = unstable_cache(
	(range: string) => getRevenueSummary(range as AnalyticsRange),
	['analytics-revenue-summary'],
	{ revalidate: 120 },
)
const cachedRecentPurchases = unstable_cache(
	(limit: number, filter: string, range: string) =>
		getRecentPurchases(
			limit,
			filter as 'all' | 'team' | 'individual',
			range as AnalyticsRange,
		),
	['analytics-recent-purchases'],
	{ revalidate: 120 },
)
const cachedRevenueByDay = unstable_cache(
	(range: string) => getRevenueByDay(range as AnalyticsRange),
	['analytics-revenue-daily'],
	{ revalidate: 300 },
)
const cachedRevenueByProduct = unstable_cache(
	(range: string) => getRevenueByProduct(range as AnalyticsRange),
	['analytics-revenue-products'],
	{ revalidate: 300 },
)
const cachedRevenueByCountry = unstable_cache(
	(range: string) => getRevenueByCountry(range as AnalyticsRange),
	['analytics-revenue-countries'],
	{ revalidate: 300 },
)
const cachedPreviousPeriod = unstable_cache(
	(range: string) => getPreviousPeriodRevenueByDay(range as AnalyticsRange),
	['analytics-prev-period'],
	{ revalidate: 21600 },
)
const cachedAttribution = unstable_cache(
	(range: string) => getAttributionSummary(range as AnalyticsRange),
	['analytics-attribution'],
	{ revalidate: 300 },
)
const cachedCoverage = unstable_cache(
	(range: string) => query('attribution/coverage', { range: range as AnalyticsRange }),
	['analytics-coverage'],
	{ revalidate: 300 },
)
const cachedShortlinks = unstable_cache(
	(range: string) => getShortlinkPerformance(range as AnalyticsRange),
	['analytics-shortlinks-v2'],
	{ revalidate: 300 },
)
const cachedTraffic = unstable_cache(
	(range: string) => query('traffic', { range: range as AnalyticsRange }),
	['analytics-traffic'],
	{ revalidate: 1800 },
)
const cachedMux = unstable_cache(
	(timeRange: string) => getVideoDashboardData(timeRange as TimeRange),
	['analytics-mux'],
	{ revalidate: 1800 },
)
const cachedThumbnails = unstable_cache(
	(timeRange: string, limit: number) =>
		getVideoThumbnails(timeRange as TimeRange, limit),
	['analytics-mux-thumbnails'],
	{ revalidate: 21600 },
)
const cachedSurveySegments = unstable_cache(
	(range: string) => query('surveys/questions', { range: range as AnalyticsRange }),
	['analytics-survey-segments'],
	{ revalidate: 300 },
)
const cachedSurveyCorrelation = unstable_cache(
	(range: string) =>
		query('correlation/survey-revenue', { range: range as AnalyticsRange }),
	['analytics-survey-correlation'],
	{ revalidate: 300 },
)
const cachedValuePaths = unstable_cache(
	(range: string) => query('value-paths/summary', { range: range as AnalyticsRange }),
	['analytics-value-paths'],
	{ revalidate: 300 },
)

export class DashboardSectionError extends Error {
	readonly code: string
	readonly userMessage: string

	constructor(code: string, userMessage = 'This analytics section is temporarily unavailable.') {
		super(userMessage)
		this.name = 'DashboardSectionError'
		this.code = code
		this.userMessage = userMessage
	}
}

/** Run server-side section work with a small, explicit concurrency cap. */
export async function runBounded<T>(
	tasks: readonly (() => Promise<T>)[],
	concurrency: number,
): Promise<T[]> {
	const results = new Array<T>(tasks.length)
	let next = 0
	const workerCount = Math.min(Math.max(1, concurrency), tasks.length)

	async function worker() {
		while (true) {
			const index = next++
			if (index >= tasks.length) return
			results[index] = await tasks[index]!()
		}
	}

	await Promise.all(Array.from({ length: workerCount }, () => worker()))
	return results
}

async function requireQuery<T>(
	resultPromise: Promise<{ ok: boolean; data?: T; error?: { code?: string } }>,
): Promise<T> {
	const result = await resultPromise
	if (!result.ok) {
		throw new DashboardSectionError(result.error?.code ?? 'QUERY_FAILED')
	}
	return result.data as T
}

function toMuxRange(range: AnalyticsRange): TimeRange {
	if (range === '7d') return '7:days'
	if (range === '90d') return '90:days'
	return '30:days'
}

async function loadDashboardSectionUnshared<S extends DashboardSection>(
	section: S,
	range: AnalyticsRange,
): Promise<DashboardSectionData[S]> {
	switch (section) {
		case 'summary':
			return {
				summary: await cachedRevenueSummary(range),
			} as DashboardSectionData[S]

		case 'revenue': {
			const [daily, byProduct, byCountry, recentPurchases, previousDaily] =
				(await runBounded(
					[
						() => cachedRevenueByDay(range),
						() => cachedRevenueByProduct(range),
						() => cachedRevenueByCountry(range),
						() => cachedRecentPurchases(20, 'team', range),
						() => cachedPreviousPeriod(range),
					],
					2,
				)) as [
					Awaited<ReturnType<typeof cachedRevenueByDay>>,
					Awaited<ReturnType<typeof cachedRevenueByProduct>>,
					Awaited<ReturnType<typeof cachedRevenueByCountry>>,
					Awaited<ReturnType<typeof cachedRecentPurchases>>,
					Awaited<ReturnType<typeof cachedPreviousPeriod>>,
				]

			return {
				daily,
				byProduct,
				byCountry,
				recentPurchases,
				previousDaily,
			} as DashboardSectionData[S]
		}

		case 'attribution': {
			const [attribution, attributionCoverage] = (await runBounded(
			[
				() => cachedAttribution(range),
				() => requireQuery(cachedCoverage(range)),
			],
			2,
			)) as [
			Awaited<ReturnType<typeof cachedAttribution>>,
			Awaited<ReturnType<typeof requireQuery>>,
		]

			return { attribution, attributionCoverage } as DashboardSectionData[S]
		}

		case 'shortlinks':
			return {
				shortlinks: await cachedShortlinks(range),
			} as DashboardSectionData[S]

		case 'traffic': {
			const [traffic, traffic180d] = await Promise.all([
				requireQuery(cachedTraffic(range)),
				requireQuery(cachedTraffic('180d')),
			])
			return {
				traffic,
				traffic180d,
			} as unknown as DashboardSectionData[S]
		}

		case 'mux': {
			const mux = await cachedMux(toMuxRange(range))
			const muxThumbnails = mux
				? await cachedThumbnails(toMuxRange(range), 10)
				: {}
			return {
				mux,
				muxThumbnails: muxThumbnails as Record<string, string>,
			} as DashboardSectionData[S]
		}

		case 'surveys': {
			const [surveySegments, surveyCorrelation] = (await runBounded<unknown>(
			[
				() => requireQuery(cachedSurveySegments(range)),
				() => requireQuery(cachedSurveyCorrelation(range)),
			],
			1,
			)) as [
				DashboardSectionData['surveys']['surveySegments'],
				DashboardSectionData['surveys']['surveyCorrelation'],
			]
			return { surveySegments, surveyCorrelation } as DashboardSectionData[S]
		}

		case 'value-paths':
			return {
				valuePaths: await requireQuery(cachedValuePaths(range)),
			} as unknown as DashboardSectionData[S]
	}
}

export type DashboardSectionLoadOptions = {
	signal?: AbortSignal
}

const inFlightDashboardSections = new Map<string, Promise<unknown>>()

function requestKey(section: DashboardSection, range: AnalyticsRange) {
	return `${section}:${range}`
}

function requestAbortedError() {
	const error = new Error('Analytics dashboard request aborted.')
	error.name = 'AbortError'
	return error
}

function awaitDashboardRequest<T>(
	shared: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return shared
	if (signal.aborted) return Promise.reject(requestAbortedError())

	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener('abort', onAbort)
			reject(requestAbortedError())
		}
		signal.addEventListener('abort', onAbort, { once: true })
		void shared.then(
			(value) => {
				signal.removeEventListener('abort', onAbort)
				resolve(value)
			},
			(error) => {
				signal.removeEventListener('abort', onAbort)
				reject(error)
			},
		)
	})
}

/**
 * Share identical in-flight section work without tying provider cancellation
 * to one browser caller. Rejections evict the entry so a retry can recover.
 */
export async function loadDashboardSection<S extends DashboardSection>(
	section: S,
	range: AnalyticsRange,
	options: DashboardSectionLoadOptions = {},
): Promise<DashboardSectionData[S]> {
	if (options.signal?.aborted) throw requestAbortedError()

	const key = requestKey(section, range)
	let shared = inFlightDashboardSections.get(key) as
		| Promise<DashboardSectionData[S]>
		| undefined
	if (!shared) {
		shared = loadDashboardSectionUnshared(section, range)
		inFlightDashboardSections.set(key, shared)
		void shared.then(
			() => {
				if (inFlightDashboardSections.get(key) === shared) {
					inFlightDashboardSections.delete(key)
				}
			},
			() => {
				if (inFlightDashboardSections.get(key) === shared) {
					inFlightDashboardSections.delete(key)
				}
			},
		)
	}

	return awaitDashboardRequest(shared, options.signal)
}

export { DASHBOARD_SECTIONS }
