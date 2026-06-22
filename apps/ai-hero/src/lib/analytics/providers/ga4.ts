import { BetaAnalyticsDataClient } from '@google-analytics/data'

import { env } from '@/env.mjs'

type GA4TrafficRange = '24h' | '7d' | '30d' | '90d' | '180d'

type TrafficBreakdownRow = {
	value: string
	sessions: number
	users: number
	sessionPercent: number
}

let client: BetaAnalyticsDataClient | null = null

function getClient(): BetaAnalyticsDataClient {
	if (!client) {
		client = new BetaAnalyticsDataClient({
			credentials: {
				client_email: env.GOOGLE_ANALYTICS_CLIENT_EMAIL ?? '',
				private_key: (env.GOOGLE_ANALYTICS_PRIVATE_KEY ?? '').replace(
					/\\n/g,
					'\n',
				),
			},
		})
	}

	return client
}

function rangeToDateRange(range: GA4TrafficRange = '30d') {
	const days: Record<GA4TrafficRange, number> = {
		'24h': 1,
		'7d': 7,
		'30d': 30,
		'90d': 90,
		'180d': 180,
	}

	return { startDate: `${days[range] ?? 30}daysAgo`, endDate: 'today' }
}

function metric(row: any, index: number) {
	return Number(row?.metricValues?.[index]?.value ?? 0)
}

function dimension(row: any, index: number, fallback = '(not set)') {
	return row?.dimensionValues?.[index]?.value || fallback
}

function toPercent(value: number, total: number) {
	if (!total) return 0
	return Number(((value / total) * 100).toFixed(2))
}

async function getBreakdown(
	range: GA4TrafficRange,
	dimensionName: string,
	limit: number,
): Promise<TrafficBreakdownRow[]> {
	const [response] = await getClient().runReport({
		property: `properties/${env.STATS_ANALYTICS_PROPERTY_ID ?? ''}`,
		dateRanges: [rangeToDateRange(range)],
		dimensions: [{ name: dimensionName }],
		metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
		orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
		limit,
	})

	const rows = response?.rows ?? []
	const breakdownSessions = rows.reduce((sum, row) => sum + metric(row, 0), 0)

	return rows.map((row) => {
		const sessions = metric(row, 0)
		return {
			value: dimension(row, 0),
			sessions,
			users: metric(row, 1),
			sessionPercent: toPercent(sessions, breakdownSessions),
		}
	})
}

export async function getTrafficOverview(range: GA4TrafficRange = '30d') {
	const [response] = await getClient().runReport({
		property: `properties/${env.STATS_ANALYTICS_PROPERTY_ID ?? ''}`,
		dateRanges: [rangeToDateRange(range)],
		metrics: [
			{ name: 'sessions' },
			{ name: 'totalUsers' },
			{ name: 'newUsers' },
			{ name: 'screenPageViews' },
			{ name: 'averageSessionDuration' },
			{ name: 'bounceRate' },
		],
	})

	const row = response?.rows?.[0]
	const sessions = metric(row, 0)
	const [deviceCategories, operatingSystems, screenResolutions] =
		await Promise.all([
			getBreakdown(range, 'deviceCategory', 10),
			getBreakdown(range, 'operatingSystem', 25),
			getBreakdown(range, 'screenResolution', 25),
		])

	return {
		sessions,
		totalUsers: metric(row, 1),
		newUsers: metric(row, 2),
		pageviews: metric(row, 3),
		avgSessionDuration: metric(row, 4),
		bounceRate: metric(row, 5),
		deviceCategories: deviceCategories.map((item) => ({
			deviceCategory: item.value,
			sessions: item.sessions,
			users: item.users,
			sessionPercent: item.sessionPercent,
		})),
		operatingSystems: operatingSystems.map((item) => ({
			operatingSystem: item.value,
			sessions: item.sessions,
			users: item.users,
			sessionPercent: item.sessionPercent,
		})),
		screenResolutions: screenResolutions.map((item) => ({
			screenResolution: item.value,
			sessions: item.sessions,
			users: item.users,
			sessionPercent: item.sessionPercent,
		})),
	}
}

export async function getTopPages(
	range: GA4TrafficRange = '30d',
	limit = 20,
) {
	const [response] = await getClient().runReport({
		property: `properties/${env.STATS_ANALYTICS_PROPERTY_ID ?? ''}`,
		dateRanges: [rangeToDateRange(range)],
		dimensions: [{ name: 'pagePath' }],
		metrics: [
			{ name: 'screenPageViews' },
			{ name: 'totalUsers' },
			{ name: 'averageSessionDuration' },
		],
		orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
		limit,
	})

	return (
		response?.rows?.map((row) => ({
			path: dimension(row, 0, ''),
			pageviews: metric(row, 0),
			users: metric(row, 1),
			avgDuration: metric(row, 2),
		})) ?? []
	)
}

export async function getTrafficSources(
	range: GA4TrafficRange = '30d',
	limit = 15,
) {
	const [response] = await getClient().runReport({
		property: `properties/${env.STATS_ANALYTICS_PROPERTY_ID ?? ''}`,
		dateRanges: [rangeToDateRange(range)],
		dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
		metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
		orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
		limit,
	})

	return (
		response?.rows?.map((row) => ({
			source: dimension(row, 0, '(direct)'),
			medium: dimension(row, 1, '(none)'),
			sessions: metric(row, 0),
			users: metric(row, 1),
		})) ?? []
	)
}

export async function getSessionsByDay(range: GA4TrafficRange = '30d') {
	const [response] = await getClient().runReport({
		property: `properties/${env.STATS_ANALYTICS_PROPERTY_ID ?? ''}`,
		dateRanges: [rangeToDateRange(range)],
		dimensions: [{ name: 'date' }],
		metrics: [
			{ name: 'sessions' },
			{ name: 'totalUsers' },
			{ name: 'screenPageViews' },
		],
		orderBys: [{ dimension: { dimensionName: 'date' }, desc: false }],
	})

	return (
		response?.rows?.map((row) => {
			const raw = dimension(row, 0, '')
			const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
			return {
				date,
				sessions: metric(row, 0),
				users: metric(row, 1),
				pageviews: metric(row, 2),
			}
		}) ?? []
	)
}

export default {
	getTrafficOverview,
	getTopPages,
	getTrafficSources,
	getSessionsByDay,
}
