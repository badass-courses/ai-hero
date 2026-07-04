import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { env } from '@/env.mjs'
import { sql } from 'drizzle-orm'

const MUX_DATA_BASE = 'https://api.mux.com/data/v1'

function getAuthHeader(): string {
	const tokenId = env.MUX_DATA_TOKEN_ID
	const tokenSecret = env.MUX_DATA_TOKEN_SECRET
	if (!tokenId || !tokenSecret) {
		throw new Error('MUX_DATA_TOKEN_ID and MUX_DATA_TOKEN_SECRET are required')
	}
	return `Basic ${Buffer.from(`${tokenId}:${tokenSecret}`).toString('base64')}`
}

async function muxDataFetch<T>(
	path: string,
	params?: Record<string, string | string[]>,
): Promise<T> {
	const url = new URL(`${MUX_DATA_BASE}${path}`)
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			if (Array.isArray(value)) {
				for (const v of value) {
					url.searchParams.append(key, v)
				}
			} else {
				url.searchParams.set(key, value)
			}
		}
	}

	const response = await fetch(url.toString(), {
		headers: {
			Authorization: getAuthHeader(),
			'Content-Type': 'application/json',
		},
		next: { revalidate: 300 }, // cache 5 minutes
	})

	if (!response.ok) {
		throw new Error(
			`Mux Data API error: ${response.status} ${response.statusText}`,
		)
	}

	return response.json() as Promise<T>
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type TimeRange = '7:days' | '30:days' | '90:days'

/** Ranges available on the Top Videos table (independent from page-level range) */
export type VideoTableRange = '24:hours' | '7:days' | '30:days' | '90:days'

export interface MuxOverallResponse {
	data: {
		value: number
		total_watch_time: number
		total_playing_time: number
		total_views: number
		global_value: number | null
	}
	timeframe: [number, number]
}

export interface MuxTimeseriesResponse {
	data: [string, number | null, number | null][]
	timeframe: [number, number]
	total_row_count: number
}

export interface MuxBreakdownItem {
	views: number
	value: number
	total_watch_time: number
	total_playing_time: number
	negative_impact: number | null
	field: string
}

export interface MuxBreakdownResponse {
	data: MuxBreakdownItem[]
	timeframe: [number, number]
	total_row_count: number
}

// ─── Comparison (unique viewers) ─────────────────────────────────────────────

interface MuxComparisonItem {
	name: string
	watch_time?: number
	view_count?: number
	unique_viewers?: number
	started_views?: number
	ended_views?: number
	[key: string]: unknown
}

interface MuxComparisonResponse {
	data: MuxComparisonItem[]
	timeframe: [number, number]
	total_row_count: number | null
}

export async function getComparisonTotals(timeRange: TimeRange = '30:days') {
	const resp = await muxDataFetch<MuxComparisonResponse>(
		'/metrics/comparison',
		{ 'timeframe[]': timeRange },
	)
	const totals = resp.data.find((d) => d.name === 'totals')
	return {
		uniqueViewers: totals?.unique_viewers ?? 0,
		viewCount: totals?.view_count ?? 0,
		watchTimeMs: totals?.watch_time ?? 0,
	}
}

// ─── API Functions ───────────────────────────────────────────────────────────

export async function getViewsOverall(timeRange: TimeRange = '30:days') {
	return muxDataFetch<MuxOverallResponse>('/metrics/views/overall', {
		'timeframe[]': timeRange,
	})
}

export async function getViewerExperienceScore(
	timeRange: TimeRange = '30:days',
) {
	return muxDataFetch<MuxOverallResponse>(
		'/metrics/viewer_experience_score/overall',
		{ 'timeframe[]': timeRange },
	)
}

export async function getViewsTimeseries(timeRange: TimeRange = '30:days') {
	return muxDataFetch<MuxTimeseriesResponse>('/metrics/views/timeseries', {
		'timeframe[]': timeRange,
		group_by: 'day',
	})
}

/**
 * Fetch watch time (playing_time) timeseries grouped by day.
 * Mux returns [date, totalPlayingTimeMs, viewCount] tuples.
 * The value IS the total playing time in ms (not the average).
 */
export async function getWatchTimeTimeseries(timeRange: TimeRange = '30:days') {
	return muxDataFetch<MuxTimeseriesResponse>(
		'/metrics/playing_time/timeseries',
		{
			'timeframe[]': timeRange,
			group_by: 'day',
		},
	)
}

export async function getVideoBreakdown(
	timeRange: TimeRange = '30:days',
	limit: number = 25,
) {
	return muxDataFetch<MuxBreakdownResponse>('/metrics/views/breakdown', {
		'timeframe[]': timeRange,
		group_by: 'video_title',
		order_by: 'views',
		order_direction: 'desc',
		limit: String(limit),
	})
}

/**
 * Standalone video breakdown fetcher for the Top Videos table's
 * independent time-range tabs. Accepts VideoTableRange.
 */
export async function getVideoBreakdownForRange(
	timeRange: VideoTableRange,
	limit: number = 50,
) {
	return muxDataFetch<MuxBreakdownResponse>('/metrics/views/breakdown', {
		'timeframe[]': timeRange,
		group_by: 'video_title',
		order_by: 'views',
		order_direction: 'desc',
		limit: String(limit),
	})
}

export async function getCountryBreakdown(
	timeRange: TimeRange = '30:days',
	limit: number = 10,
) {
	return muxDataFetch<MuxBreakdownResponse>('/metrics/views/breakdown', {
		'timeframe[]': timeRange,
		group_by: 'country',
		order_by: 'views',
		order_direction: 'desc',
		limit: String(limit),
	})
}

export async function getVideoDetailBreakdowns(
	videoTitle: string,
	timeRange: TimeRange = '30:days',
) {
	const filter = `video_title:${videoTitle}`
	const [countries, timeseries] = await Promise.all([
		muxDataFetch<MuxBreakdownResponse>('/metrics/views/breakdown', {
			'timeframe[]': timeRange,
			group_by: 'country',
			order_by: 'views',
			order_direction: 'desc',
			limit: '8',
			'filters[]': filter,
		}),
		muxDataFetch<MuxTimeseriesResponse>('/metrics/views/timeseries', {
			'timeframe[]': timeRange,
			group_by: 'day',
			'filters[]': filter,
		}),
	])

	return {
		countries: countries.data.map((c) => ({
			country: c.field,
			views: c.views,
			watchTimeMs: c.total_watch_time,
		})),
		timeseries: timeseries.data.map(([date, value]) => ({
			date,
			views: value ?? 0,
		})),
	}
}

export type VideoDetailBreakdowns = Awaited<
	ReturnType<typeof getVideoDetailBreakdowns>
>

// ─── Per-video summary (cms Video/Media analytics strip) ─────────────────────

export interface VideoSummary {
	totalViews: number
	uniqueViewers: number
	totalWatchTimeMs: number
	/** Mux viewer experience score 0–100; null when no views in range. */
	experienceScore: number | null
	/** Human label for the window the numbers cover. */
	rangeLabel: string
	/** Deep link to the full breakdown. */
	dashboardHref: string
}

/**
 * Compact 30-day summary for ONE video, keyed on `video_id` = the
 * videoResource id (the key every public player sends via `useMuxMetadata`).
 * Mirrors `getVideoDetailBreakdowns`' `filters[]` shape; 5-min revalidate via
 * `muxDataFetch`. Returns null when the video had no views in range —
 * callers render nothing (no data ≠ error).
 */
export async function getVideoSummary(
	videoResourceId: string,
): Promise<VideoSummary | null> {
	const filter = `video_id:${videoResourceId}`
	const timeRange: TimeRange = '30:days'
	const [views, experience, comparison] = await Promise.all([
		muxDataFetch<MuxOverallResponse>('/metrics/views/overall', {
			'timeframe[]': timeRange,
			'filters[]': filter,
		}),
		muxDataFetch<MuxOverallResponse>(
			'/metrics/viewer_experience_score/overall',
			{ 'timeframe[]': timeRange, 'filters[]': filter },
		),
		muxDataFetch<MuxComparisonResponse>('/metrics/comparison', {
			'timeframe[]': timeRange,
			'filters[]': filter,
		}),
	])

	const totalViews = views.data.total_views ?? 0
	if (totalViews === 0) return null

	const totals = comparison.data.find((d) => d.name === 'totals')
	return {
		totalViews,
		uniqueViewers: totals?.unique_viewers ?? 0,
		totalWatchTimeMs: views.data.total_watch_time ?? 0,
		experienceScore:
			typeof experience.data.value === 'number' ? experience.data.value : null,
		rangeLabel: 'Last 30 days',
		dashboardHref: '/admin/video-dashboard',
	}
}

// ─── Aggregate fetcher ───────────────────────────────────────────────────────

export interface VideoDashboardData {
	overview: {
		totalViews: number
		uniqueViewers: number
		totalWatchTimeMs: number
		totalPlayingTimeMs: number
		viewerExperienceScore: number
		globalExperienceScore: number | null
	}
	watchTimeSeries: {
		date: string
		watchTimeMs: number
	}[]
	topVideos: {
		title: string
		views: number
		watchTimeMs: number
		playingTimeMs: number
	}[]
	countries: {
		country: string
		views: number
		watchTimeMs: number
	}[]
}

export async function getVideoDashboardData(
	timeRange: TimeRange = '30:days',
): Promise<VideoDashboardData> {
	const [views, experience, comparison, watchTime, videos, countries] =
		await Promise.all([
			getViewsOverall(timeRange),
			getViewerExperienceScore(timeRange),
			getComparisonTotals(timeRange),
			getWatchTimeTimeseries(timeRange),
			getVideoBreakdown(timeRange, 50),
			getCountryBreakdown(timeRange, 15),
		])

	return {
		overview: {
			totalViews: views.data.total_views,
			uniqueViewers: comparison.uniqueViewers,
			totalWatchTimeMs: views.data.total_watch_time,
			totalPlayingTimeMs: views.data.total_playing_time,
			viewerExperienceScore: experience.data.value,
			globalExperienceScore: experience.data.global_value,
		},
		watchTimeSeries: watchTime.data.map(([date, totalMs]) => ({
			date,
			// Mux playing_time timeseries: value is total playing time in ms for the day
			watchTimeMs: totalMs ?? 0,
		})),
		topVideos: videos.data
			.filter((v) => v.field !== '')
			.map((v) => ({
				title: v.field,
				views: v.views,
				watchTimeMs: v.total_watch_time,
				playingTimeMs: v.total_playing_time,
			})),
		countries: countries.data.map((c) => ({
			country: c.field,
			views: c.views,
			watchTimeMs: c.total_watch_time,
		})),
	}
}

/**
 * Resolve video titles to Mux thumbnail URLs.
 * 1. Break down by video_id to get ContentResource IDs for top videos
 * 2. Look up playback IDs from ContentResource.fields.muxPlaybackId
 * 3. Build image.mux.com thumbnail URLs
 * Returns Record<title, thumbnailUrl>.
 */
export async function getVideoThumbnails(
	timeRange: TimeRange = '30:days',
	limit: number = 10,
): Promise<Record<string, string>> {
	// Get breakdown by both video_id and video_title
	const [byId, byTitle] = await Promise.all([
		muxDataFetch<MuxBreakdownResponse>('/metrics/views/breakdown', {
			'timeframe[]': timeRange,
			group_by: 'video_id',
			order_by: 'views',
			order_direction: 'desc',
			limit: String(limit),
		}),
		muxDataFetch<MuxBreakdownResponse>('/metrics/views/breakdown', {
			'timeframe[]': timeRange,
			group_by: 'video_title',
			order_by: 'views',
			order_direction: 'desc',
			limit: String(limit),
		}),
	])

	// video_id breakdown gives ContentResource IDs — look up playback IDs
	const videoIds = byId.data
		.filter((v) => v.field && v.field !== '')
		.map((v) => v.field)

	if (videoIds.length === 0) return {}

	const rows = await db
		.select({
			id: contentResource.id,
			playbackId:
				sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.muxPlaybackId'))`.as(
					'playbackId',
				),
		})
		.from(contentResource)
		.where(
			sql`${contentResource.id} IN (${sql.join(
				videoIds.map((id) => sql`${id}`),
				sql`, `,
			)})`,
		)

	// Map video_id → playbackId
	const idToPlayback = new Map<string, string>()
	for (const r of rows) {
		if (r.playbackId && r.playbackId !== 'null') {
			idToPlayback.set(r.id, r.playbackId)
		}
	}

	// Match by position: byId and byTitle are both sorted by views desc,
	// so position i in byId corresponds to position i in byTitle
	const result: Record<string, string> = {}
	for (let i = 0; i < Math.min(byId.data.length, byTitle.data.length); i++) {
		const videoId = byId.data[i]?.field
		const title = byTitle.data[i]?.field
		if (!videoId || !title) continue
		const playbackId = idToPlayback.get(videoId)
		if (playbackId) {
			result[title] =
				`https://image.mux.com/${playbackId}/thumbnail.jpg?width=240&height=135&fit_mode=smartcrop`
		}
	}

	return result
}
