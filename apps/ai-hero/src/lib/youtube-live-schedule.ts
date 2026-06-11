import { unstable_cache } from 'next/cache'
import {
	listYouTubeLiveBroadcasts,
	type YouTubeLiveBroadcast,
	type YouTubeLiveBroadcastStatus,
} from '@/lib/youtube-live-broadcasts'
import { log, serializeError } from '@/server/logger'

const ACTIVE_CACHE_SECONDS = 60
const MAX_BROADCASTS = 10
const PUBLIC_PRIVACY_STATUSES = new Set(['public'])

export type PublicYouTubeLiveStatus = 'live'

export type PublicYouTubeLiveBroadcast = {
	id: string
	title: string
	description: string
	scheduledStartTime: string | null
	scheduledEndTime: string | null
	actualStartTime: string | null
	actualEndTime: string | null
	lifeCycleStatus: string | null
	privacyStatus: 'public'
	status: PublicYouTubeLiveStatus
	watchUrl: string
}

export type HomepageYouTubeLiveBroadcasts = {
	active: PublicYouTubeLiveBroadcast[]
}

function compareBroadcastStartTime(
	a: PublicYouTubeLiveBroadcast,
	b: PublicYouTubeLiveBroadcast,
) {
	const aTime = a.actualStartTime || a.scheduledStartTime || ''
	const bTime = b.actualStartTime || b.scheduledStartTime || ''

	return aTime.localeCompare(bTime)
}

export function toPublicYouTubeLiveBroadcast(
	broadcast: YouTubeLiveBroadcast,
	status: PublicYouTubeLiveStatus,
): PublicYouTubeLiveBroadcast | null {
	// Only surface fully public broadcasts on the homepage. Unlisted streams
	// (e.g. cohort office hours) must not leak to unauthenticated visitors.
	if (broadcast.privacyStatus !== 'public') {
		return null
	}

	return {
		id: broadcast.id,
		title: broadcast.title,
		description: broadcast.description,
		scheduledStartTime: broadcast.scheduledStartTime,
		scheduledEndTime: broadcast.scheduledEndTime,
		actualStartTime: broadcast.actualStartTime,
		actualEndTime: broadcast.actualEndTime,
		lifeCycleStatus: broadcast.lifeCycleStatus,
		privacyStatus: broadcast.privacyStatus,
		status,
		watchUrl: broadcast.watchUrl,
	}
}

async function getPublicBroadcastsByStatus(
	broadcastStatus: Extract<YouTubeLiveBroadcastStatus, 'active'>,
	displayStatus: PublicYouTubeLiveStatus,
) {
	try {
		const broadcasts = await listYouTubeLiveBroadcasts(
			MAX_BROADCASTS,
			broadcastStatus,
		)
		const publicBroadcasts = broadcasts
			.map((broadcast) =>
				toPublicYouTubeLiveBroadcast(broadcast, displayStatus),
			)
			.filter((broadcast): broadcast is PublicYouTubeLiveBroadcast =>
				Boolean(broadcast),
			)
			.sort(compareBroadcastStartTime)

		await log.info('youtube.live.publicBroadcasts.loaded', {
			broadcastStatus,
			displayStatus,
			maxBroadcasts: MAX_BROADCASTS,
			candidateCount: broadcasts.length,
			publicCount: publicBroadcasts.length,
			broadcastIds: publicBroadcasts.map((broadcast) => broadcast.id),
			privacyStatuses: broadcasts.map((broadcast) => broadcast.privacyStatus),
			lifeCycleStatuses: broadcasts.map(
				(broadcast) => broadcast.lifeCycleStatus,
			),
			hasPrivateBroadcasts: broadcasts.some(
				(broadcast) =>
					!broadcast.privacyStatus ||
					!PUBLIC_PRIVACY_STATUSES.has(broadcast.privacyStatus),
			),
		})

		return publicBroadcasts
	} catch (error) {
		await log.warn('youtube.live.publicBroadcasts.failed', {
			broadcastStatus,
			displayStatus,
			maxBroadcasts: MAX_BROADCASTS,
			error: serializeError(error),
		})

		return []
	}
}

const getCachedActiveYouTubeLiveBroadcasts = unstable_cache(
	() => getPublicBroadcastsByStatus('active', 'live'),
	['youtube-live-broadcasts-active-v1'],
	{
		revalidate: ACTIVE_CACHE_SECONDS,
		tags: ['youtube-live-broadcasts', 'youtube-live-broadcasts-active'],
	},
)

export async function getHomepageYouTubeLiveBroadcasts(): Promise<HomepageYouTubeLiveBroadcasts> {
	const active = await getCachedActiveYouTubeLiveBroadcasts()

	return {
		active,
	}
}
