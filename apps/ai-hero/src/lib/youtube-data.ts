import { env } from '@/env.mjs'
import { google } from 'googleapis'

// ─── Auth ────────────────────────────────────────────────────────────────────

function getOAuth2Client() {
	const clientId = env.YOUTUBE_OAUTH_CLIENT_ID
	const clientSecret = env.YOUTUBE_OAUTH_CLIENT_SECRET
	const refreshToken = env.YOUTUBE_ANALYTICS_REFRESH_TOKEN

	if (!clientId || !clientSecret || !refreshToken) return null

	const auth = new google.auth.OAuth2(clientId, clientSecret)
	auth.setCredentials({ refresh_token: refreshToken })
	return auth
}

// ─── Range mapping ────────────────────────────────────────────────────────────

export type YouTubeRange = '24h' | '7d' | '30d' | '90d'

function toStartDate(range: YouTubeRange): string {
	const now = new Date()
	const days: Record<YouTubeRange, number> = {
		'24h': 7,
		'7d': 7,
		'30d': 30,
		'90d': 90,
	}
	const d = new Date(now.getTime() - days[range] * 24 * 60 * 60 * 1000)
	return d.toISOString().split('T')[0]!
}

function todayDate(): string {
	return new Date().toISOString().split('T')[0]!
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface YouTubeChannelOverview {
	subscriberCount: number
	viewCount: number
	videoCount: number
}

export interface YouTubeVideoPerformance {
	videoId: string
	views: number
	estimatedMinutesWatched: number
	averageViewDuration: number
	subscribersGained: number
	likes: number
	comments: number
}

export interface YouTubeVideoWithTitle extends YouTubeVideoPerformance {
	title: string
	thumbnailUrl: string | null
}

export interface YouTubeTimeseriesPoint {
	date: string
	views: number
	watchMinutes: number
}

export interface YouTubeTrafficSource {
	source: string
	views: number
	watchMinutes: number
}

// ─── API functions ────────────────────────────────────────────────────────────

/**
 * Channel-level statistics: subscriber count, total views, video count.
 * Returns null when OAuth refresh token is not configured.
 */
export async function getChannelOverview(): Promise<YouTubeChannelOverview | null> {
	const auth = getOAuth2Client()
	if (!auth) return null

	const youtube = google.youtube({ version: 'v3', auth })
	const res = await youtube.channels.list({
		mine: true,
		part: ['statistics'],
	})

	const stats = res.data.items?.[0]?.statistics
	if (!stats) return null

	return {
		subscriberCount: Number(stats.subscriberCount ?? 0),
		viewCount: Number(stats.viewCount ?? 0),
		videoCount: Number(stats.videoCount ?? 0),
	}
}

/**
 * Per-video performance metrics sorted by views descending.
 * Returns null when OAuth refresh token is not configured.
 */
export async function getVideoPerformance(
	range: YouTubeRange,
	limit = 25,
): Promise<YouTubeVideoPerformance[] | null> {
	const auth = getOAuth2Client()
	if (!auth) return null

	const youtubeAnalytics = google.youtubeAnalytics({ version: 'v2', auth })
	const res = await youtubeAnalytics.reports.query({
		ids: 'channel==MINE',
		startDate: toStartDate(range),
		endDate: todayDate(),
		dimensions: 'video',
		metrics:
			'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,likes,comments',
		sort: '-views',
		maxResults: limit,
	})

	const rows = res.data.rows ?? []
	return rows.map((row) => ({
		videoId: String(row[0] ?? ''),
		views: Number(row[1] ?? 0),
		estimatedMinutesWatched: Number(row[2] ?? 0),
		averageViewDuration: Number(row[3] ?? 0),
		subscribersGained: Number(row[4] ?? 0),
		likes: Number(row[5] ?? 0),
		comments: Number(row[6] ?? 0),
	}))
}

/**
 * Daily timeseries of views and watch minutes.
 * Returns null when OAuth refresh token is not configured.
 */
export async function getChannelTimeseries(
	range: YouTubeRange,
): Promise<YouTubeTimeseriesPoint[] | null> {
	const auth = getOAuth2Client()
	if (!auth) return null

	const youtubeAnalytics = google.youtubeAnalytics({ version: 'v2', auth })
	const res = await youtubeAnalytics.reports.query({
		ids: 'channel==MINE',
		startDate: toStartDate(range),
		endDate: todayDate(),
		dimensions: 'day',
		metrics: 'views,estimatedMinutesWatched',
		sort: 'day',
	})

	const rows = res.data.rows ?? []
	return rows.map((row) => ({
		date: String(row[0] ?? ''),
		views: Number(row[1] ?? 0),
		watchMinutes: Number(row[2] ?? 0),
	}))
}

/**
 * Traffic source breakdown — where viewers came from.
 * Returns null when OAuth refresh token is not configured.
 */
export async function getYouTubeTrafficSources(
	range: YouTubeRange,
): Promise<YouTubeTrafficSource[] | null> {
	const auth = getOAuth2Client()
	if (!auth) return null

	const youtubeAnalytics = google.youtubeAnalytics({ version: 'v2', auth })
	const res = await youtubeAnalytics.reports.query({
		ids: 'channel==MINE',
		startDate: toStartDate(range),
		endDate: todayDate(),
		dimensions: 'insightTrafficSourceType',
		metrics: 'views,estimatedMinutesWatched',
		sort: '-views',
	})

	const rows = res.data.rows ?? []
	return rows.map((row) => ({
		source: String(row[0] ?? ''),
		views: Number(row[1] ?? 0),
		watchMinutes: Number(row[2] ?? 0),
	}))
}

/**
 * Top videos with resolved titles and thumbnails.
 * Calls getVideoPerformance then batch-resolves IDs via YouTube Data API.
 * Returns null when OAuth refresh token is not configured.
 */
export async function getVideoPerformanceWithTitles(
	range: YouTubeRange,
	limit = 10,
): Promise<YouTubeVideoWithTitle[] | null> {
	const auth = getOAuth2Client()
	if (!auth) return null

	const videos = await getVideoPerformance(range, limit)
	if (!videos || videos.length === 0) return []

	const youtube = google.youtube({ version: 'v3', auth })
	const ids = videos.map((v) => v.videoId)

	// YouTube Data API allows up to 50 IDs per request
	const res = await youtube.videos.list({
		id: ids,
		part: ['snippet'],
	})

	const titleMap = new Map<
		string,
		{ title: string; thumbnail: string | null }
	>()
	for (const item of res.data.items ?? []) {
		titleMap.set(item.id!, {
			title: item.snippet?.title ?? item.id!,
			thumbnail: item.snippet?.thumbnails?.medium?.url ?? null,
		})
	}

	return videos.map((v) => {
		const info = titleMap.get(v.videoId)
		return {
			...v,
			title: info?.title ?? v.videoId,
			thumbnailUrl: info?.thumbnail ?? null,
		}
	})
}
