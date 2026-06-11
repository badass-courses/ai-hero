'use server'

import {
	getVideoBreakdownForRange,
	getVideoDetailBreakdowns,
	type TimeRange,
	type VideoDetailBreakdowns,
	type VideoTableRange,
} from '@/lib/mux-data'
import { getServerAuthSession } from '@/server/auth'

export async function fetchVideoDetail(
	videoTitle: string,
	timeRange: TimeRange,
): Promise<VideoDetailBreakdowns | null> {
	const { ability } = await getServerAuthSession()
	if (ability.cannot('manage', 'all')) {
		return null
	}

	return getVideoDetailBreakdowns(videoTitle, timeRange)
}

export type VideoSortBy = 'views' | 'watch_time'

export async function fetchVideoBreakdown(
	timeRange: VideoTableRange,
	sortBy: VideoSortBy = 'views',
) {
	const { ability } = await getServerAuthSession()
	if (ability.cannot('manage', 'all')) {
		return []
	}

	const result = await getVideoBreakdownForRange(timeRange, 50)
	const videos = result.data
		.filter((v) => v.field !== '')
		.map((v) => ({
			title: v.field,
			views: v.views,
			watchTimeMs: v.total_watch_time,
			playingTimeMs: v.total_playing_time,
		}))

	if (sortBy === 'watch_time') {
		videos.sort((a, b) => b.watchTimeMs - a.watchTimeMs)
	}

	return videos
}
