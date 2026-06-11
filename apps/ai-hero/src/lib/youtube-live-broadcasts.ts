import { env } from '@/env.mjs'
import { createYouTubeWatchUrl } from '@/lib/cohort-office-hours'
import { google, type youtube_v3 } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'

const YOUTUBE_FORCE_SSL_SCOPE =
	'https://www.googleapis.com/auth/youtube.force-ssl'

export type YouTubeLiveBroadcast = {
	id: string
	title: string
	description: string
	scheduledStartTime: string | null
	scheduledEndTime: string | null
	actualStartTime: string | null
	actualEndTime: string | null
	lifeCycleStatus: string | null
	privacyStatus: string | null
	boundStreamId: string | null
	watchUrl: string
	raw: youtube_v3.Schema$LiveBroadcast
}

export const DEFAULT_YOUTUBE_LIVE_THUMBNAIL_URL =
	'https://res.cloudinary.com/total-typescript/image/upload/v1779101607/ai-coding-for-real-engineers-office-hours-thumbnail.jpg'

const YOUTUBE_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024
const YOUTUBE_THUMBNAIL_MIME_TYPES = new Set(['image/jpeg', 'image/png'])

export type YouTubeLiveStream = {
	id: string
	title: string
	streamStatus: string | null
	healthStatus: string | null
}

export type CreateYouTubeLiveBroadcastInput = {
	title: string
	description?: string
	scheduledStartTime: string
	scheduledEndTime?: string
	privacyStatus?: 'private' | 'public' | 'unlisted'
	streamId?: string
	thumbnailUrl?: string
}

export type UpdateYouTubeLiveBroadcastInput = {
	id: string
	title?: string
	description?: string
	scheduledStartTime?: string
	scheduledEndTime?: string
	privacyStatus?: 'private' | 'public' | 'unlisted'
}

export type YouTubeLiveBroadcastStatus =
	| 'active'
	| 'all'
	| 'completed'
	| 'upcoming'

export type YouTubeLiveThumbnailUpload = {
	videoId: string
	imageUrl: string
	contentType: string
	bytes: number
}

function getOAuth2Client() {
	const clientId = env.YOUTUBE_OAUTH_CLIENT_ID
	const clientSecret = env.YOUTUBE_OAUTH_CLIENT_SECRET
	const refreshToken = env.YOUTUBE_ANALYTICS_REFRESH_TOKEN

	if (!clientId || !clientSecret || !refreshToken) {
		throw new Error(
			'YouTube OAuth client ID, secret, and refresh token are required',
		)
	}

	const auth = new OAuth2Client(clientId, clientSecret)
	auth.setCredentials({ refresh_token: refreshToken })

	return auth
}

function getYouTubeClient() {
	return google.youtube({ version: 'v3', auth: getOAuth2Client() })
}

async function getThumbnailUpload(imageUrl: string) {
	const response = await fetch(imageUrl)

	if (!response.ok) {
		throw new Error(
			`Failed to fetch YouTube thumbnail image: ${response.status}`,
		)
	}

	const contentType = response.headers
		.get('content-type')
		?.split(';')[0]
		?.trim()
		.toLowerCase()

	if (!contentType || !YOUTUBE_THUMBNAIL_MIME_TYPES.has(contentType)) {
		throw new Error(
			`YouTube thumbnail must be JPEG or PNG, received ${contentType || 'unknown'}`,
		)
	}

	const bytes = Buffer.from(await response.arrayBuffer())
	if (bytes.byteLength > YOUTUBE_THUMBNAIL_MAX_BYTES) {
		throw new Error(
			`YouTube thumbnail must be under 2MB, received ${bytes.byteLength} bytes`,
		)
	}

	return {
		contentType,
		bytes,
	}
}

function parseScopes(value: string | null | undefined) {
	if (!value) return []

	return value
		.split(' ')
		.map((scope) => scope.trim())
		.filter(Boolean)
}

function mapBroadcast(
	broadcast: youtube_v3.Schema$LiveBroadcast,
): YouTubeLiveBroadcast | null {
	if (!broadcast.id || !broadcast.snippet?.title) {
		return null
	}

	return {
		id: broadcast.id,
		title: broadcast.snippet.title,
		description: broadcast.snippet.description || '',
		scheduledStartTime: broadcast.snippet.scheduledStartTime || null,
		scheduledEndTime: broadcast.snippet.scheduledEndTime || null,
		actualStartTime: broadcast.snippet.actualStartTime || null,
		actualEndTime: broadcast.snippet.actualEndTime || null,
		lifeCycleStatus: broadcast.status?.lifeCycleStatus || null,
		privacyStatus: broadcast.status?.privacyStatus || null,
		boundStreamId: broadcast.contentDetails?.boundStreamId || null,
		watchUrl: createYouTubeWatchUrl(broadcast.id),
		raw: broadcast,
	}
}

export async function verifyYouTubeForceSslScope() {
	const refreshToken = env.YOUTUBE_ANALYTICS_REFRESH_TOKEN
	const clientId = env.YOUTUBE_OAUTH_CLIENT_ID
	const clientSecret = env.YOUTUBE_OAUTH_CLIENT_SECRET

	if (!refreshToken || !clientId || !clientSecret) {
		return {
			grantedScopes: [],
			hasForceSsl: false,
		}
	}

	const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: refreshToken,
			grant_type: 'refresh_token',
		}),
	})

	if (!tokenResponse.ok) {
		throw new Error(
			`Failed to refresh YouTube OAuth token: ${tokenResponse.status}`,
		)
	}

	const tokenJson = (await tokenResponse.json()) as {
		scope?: string
	}
	const grantedScopes = parseScopes(tokenJson.scope)

	return {
		grantedScopes,
		hasForceSsl: grantedScopes.includes(YOUTUBE_FORCE_SSL_SCOPE),
	}
}

export async function listYouTubeLiveBroadcasts(
	maxResults = 50,
	broadcastStatus?: YouTubeLiveBroadcastStatus,
) {
	const youtube = getYouTubeClient()
	const broadcasts = await youtube.liveBroadcasts.list({
		maxResults,
		part: ['id', 'snippet', 'status', 'contentDetails'],
		...(broadcastStatus ? { broadcastStatus } : { mine: true }),
	})

	return (broadcasts.data.items || [])
		.map(mapBroadcast)
		.filter((broadcast): broadcast is YouTubeLiveBroadcast =>
			Boolean(broadcast),
		)
}

export async function getYouTubeLiveBroadcast(id: string) {
	const youtube = getYouTubeClient()
	const response = await youtube.liveBroadcasts.list({
		id: [id],
		part: ['id', 'snippet', 'status', 'contentDetails'],
	})

	const broadcast = response.data.items?.[0]
	return broadcast ? mapBroadcast(broadcast) : null
}

export async function listYouTubeLiveStreams(maxResults = 25) {
	const youtube = getYouTubeClient()
	const response = await youtube.liveStreams.list({
		mine: true,
		maxResults,
		part: ['id', 'snippet', 'status'],
	})

	return (response.data.items || [])
		.map((stream) => {
			if (!stream.id || !stream.snippet?.title) return null

			return {
				id: stream.id,
				title: stream.snippet.title,
				streamStatus: stream.status?.streamStatus || null,
				healthStatus: stream.status?.healthStatus?.status || null,
			} satisfies YouTubeLiveStream
		})
		.filter((stream): stream is YouTubeLiveStream => Boolean(stream))
}

export async function getDefaultYouTubeLiveStreamId() {
	const streams = await listYouTubeLiveStreams()
	const defaultStream =
		streams.find((stream) => stream.title === 'Default stream key') ||
		streams[0]

	if (!defaultStream) {
		throw new Error('No reusable YouTube live stream is available')
	}

	return defaultStream.id
}

export async function createYouTubeLiveBroadcast(
	input: CreateYouTubeLiveBroadcastInput,
) {
	const youtube = getYouTubeClient()
	const created = await youtube.liveBroadcasts.insert({
		part: ['snippet', 'status', 'contentDetails'],
		requestBody: {
			snippet: {
				title: input.title,
				description: input.description || '',
				scheduledStartTime: input.scheduledStartTime,
				...(input.scheduledEndTime
					? { scheduledEndTime: input.scheduledEndTime }
					: {}),
			},
			status: {
				privacyStatus: input.privacyStatus || 'unlisted',
				selfDeclaredMadeForKids: false,
			},
			contentDetails: {
				enableAutoStart: false,
				enableAutoStop: false,
				enableDvr: true,
				enableEmbed: true,
				recordFromStart: true,
				monitorStream: {
					enableMonitorStream: true,
					broadcastStreamDelayMs: 0,
				},
			},
		},
	})

	if (!created.data.id) {
		throw new Error('YouTube broadcast creation did not return an ID')
	}

	const streamId = input.streamId || (await getDefaultYouTubeLiveStreamId())
	await youtube.liveBroadcasts.bind({
		id: created.data.id,
		part: ['id', 'snippet', 'status', 'contentDetails'],
		streamId,
	})

	const broadcast = await getYouTubeLiveBroadcast(created.data.id)
	if (!broadcast) {
		throw new Error('Created YouTube broadcast could not be reloaded')
	}

	if (input.thumbnailUrl) {
		await setYouTubeLiveBroadcastThumbnail({
			videoId: broadcast.id,
			imageUrl: input.thumbnailUrl,
		})
	}

	return broadcast
}

export async function updateYouTubeLiveBroadcast(
	input: UpdateYouTubeLiveBroadcastInput,
) {
	const youtube = getYouTubeClient()
	const existing = await youtube.liveBroadcasts.list({
		id: [input.id],
		part: ['id', 'snippet', 'status', 'contentDetails'],
	})
	const current = existing.data.items?.[0]

	if (!current?.id || !current.snippet?.title) {
		throw new Error(`YouTube broadcast not found: ${input.id}`)
	}

	await youtube.liveBroadcasts.update({
		part: ['snippet', 'status'],
		requestBody: {
			id: current.id,
			snippet: {
				title: input.title || current.snippet.title,
				description: input.description ?? current.snippet.description ?? '',
				scheduledStartTime:
					input.scheduledStartTime || current.snippet.scheduledStartTime,
				scheduledEndTime:
					input.scheduledEndTime || current.snippet.scheduledEndTime,
			},
			status: {
				privacyStatus:
					input.privacyStatus || current.status?.privacyStatus || 'unlisted',
				selfDeclaredMadeForKids:
					current.status?.selfDeclaredMadeForKids || false,
			},
		},
	})

	const updated = await getYouTubeLiveBroadcast(input.id)
	if (!updated) {
		throw new Error(
			`Updated YouTube broadcast could not be reloaded: ${input.id}`,
		)
	}

	return updated
}

export async function setYouTubeLiveBroadcastThumbnail({
	videoId,
	imageUrl,
}: {
	videoId: string
	imageUrl: string
}): Promise<YouTubeLiveThumbnailUpload> {
	const youtube = getYouTubeClient()
	const upload = await getThumbnailUpload(imageUrl)

	await youtube.thumbnails.set({
		videoId,
		media: {
			mimeType: upload.contentType,
			body: upload.bytes,
		},
	})

	return {
		videoId,
		imageUrl,
		contentType: upload.contentType,
		bytes: upload.bytes.byteLength,
	}
}
