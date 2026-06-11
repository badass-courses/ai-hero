import { NextRequest, NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import {
	requireCreateConfirmation,
	toCreateYouTubeLiveBroadcastInput,
	toYouTubeLiveBroadcastReceipt,
	YouTubeLiveBroadcastCreateBodySchema,
} from '@/lib/youtube-live-admin'
import {
	createYouTubeLiveBroadcast,
	listYouTubeLiveBroadcasts,
	listYouTubeLiveStreams,
} from '@/lib/youtube-live-broadcasts'
import { withSkill } from '@/server/with-skill'

import {
	buildTelemetry,
	conflictResponse,
	forbiddenResponse,
	getBroadcastStatusFromRequest,
	getLimitFromRequest,
	flushLogsSafely,
	getYouTubeLiveAdminAuth,
	logFailedOperation,
	logInfoSafely,
	payloadTelemetry,
	unauthorizedResponse,
	upstreamErrorResponse,
	validationErrorResponse,
	youtubeLiveCorsHeaders,
} from './_utils'

const endpoint = '/api/admin/youtube/live-broadcasts'

export const OPTIONS = () =>
	NextResponse.json({}, { headers: youtubeLiveCorsHeaders })

async function resolveStream(streamId?: string) {
	const streams = await listYouTubeLiveStreams()
	if (streamId) {
		return streams.find((stream) => stream.id === streamId) ?? null
	}

	return streams.find((stream) => stream.title === 'Default stream key') ?? null
}

export const GET = withSkill(async (request: NextRequest) => {
	const auth = await getYouTubeLiveAdminAuth(request)
	if (!auth.user) return unauthorizedResponse(endpoint)
	if (!auth.authorized) return forbiddenResponse(endpoint)

	const status = getBroadcastStatusFromRequest(request)
	if (!status.ok) {
		return validationErrorResponse(endpoint, {
			status: [`Invalid status: ${status.rawStatus}`],
		})
	}

	const limit = getLimitFromRequest(request)
	const startedAt = Date.now()

	await logInfoSafely('youtube.live.broadcasts.list.started', () =>
		buildTelemetry(request, auth, {
			operation: 'list',
			broadcastStatus: status.status,
			limit,
		}),
	)

	try {
		const broadcasts = await listYouTubeLiveBroadcasts(limit, status.status)
		await logInfoSafely('youtube.live.broadcasts.list.succeeded', () =>
			buildTelemetry(request, auth, {
				operation: 'list',
				broadcastStatus: status.status,
				limit,
				broadcastCount: broadcasts.length,
				durationMs: Date.now() - startedAt,
				broadcastIds: broadcasts.map((broadcast) => broadcast.id),
				broadcastTitles: broadcasts.map((broadcast) => broadcast.title),
			}),
		)

		return NextResponse.json(
			{
				ok: true,
				endpoint,
				status: status.status,
				limit,
				broadcasts: broadcasts.map(toYouTubeLiveBroadcastReceipt),
			},
			{ headers: youtubeLiveCorsHeaders },
		)
	} catch (error) {
		await logFailedOperation(
			'youtube.live.broadcasts.list.failed',
			request,
			auth,
			error,
			{
				operation: 'list',
				broadcastStatus: status.status,
				limit,
				durationMs: Date.now() - startedAt,
			},
		)
		return upstreamErrorResponse(endpoint, error)
	}
})

export const POST = withSkill(async (request: NextRequest) => {
	const auth = await getYouTubeLiveAdminAuth(request)
	if (!auth.user) return unauthorizedResponse(endpoint)
	if (!auth.authorized) return forbiddenResponse(endpoint)

	const body = await request.json().catch(() => null)
	const parsed = YouTubeLiveBroadcastCreateBodySchema.safeParse(body)
	if (!parsed.success) {
		return validationErrorResponse(endpoint, parsed.error.format())
	}

	const payload = toCreateYouTubeLiveBroadcastInput(parsed.data)
	const startedAt = Date.now()

	await logInfoSafely('youtube.live.broadcast.create.requested', () =>
		buildTelemetry(request, auth, {
			operation: 'create',
			confirmed: requireCreateConfirmation(parsed.data),
			...payloadTelemetry(payload),
		}),
	)

	if (!requireCreateConfirmation(parsed.data)) {
		return conflictResponse(
			endpoint,
			'CONFIRMATION_REQUIRED',
			'confirm must equal CREATE_YOUTUBE_BROADCAST',
		)
	}

	try {
		const stream = await resolveStream(parsed.data.streamId)
		if (!stream) {
			return validationErrorResponse(endpoint, {
				streamId: [
					parsed.data.streamId
						? `Stream not found: ${parsed.data.streamId}`
						: 'Default stream key not found',
				],
			})
		}

		const broadcast = await createYouTubeLiveBroadcast({
			...payload,
			streamId: stream.id,
		})
		revalidateTag('youtube-live-broadcasts', 'max')
		revalidateTag('youtube-live-broadcasts-active', 'max')

		await logInfoSafely('youtube.live.broadcast.create.succeeded', () =>
			buildTelemetry(request, auth, {
				operation: 'create',
				confirmed: true,
				durationMs: Date.now() - startedAt,
				streamTitle: stream.title,
				streamStatus: stream.streamStatus,
				streamHealthStatus: stream.healthStatus,
				...payloadTelemetry(broadcast),
			}),
		)
		await flushLogsSafely()

		return NextResponse.json(
			{
				ok: true,
				endpoint,
				broadcast: toYouTubeLiveBroadcastReceipt(broadcast),
				stream,
			},
			{ status: 201, headers: youtubeLiveCorsHeaders },
		)
	} catch (error) {
		await logFailedOperation(
			'youtube.live.broadcast.create.failed',
			request,
			auth,
			error,
			{
				operation: 'create',
				confirmed: true,
				durationMs: Date.now() - startedAt,
				...payloadTelemetry(payload),
			},
		)
		return upstreamErrorResponse(endpoint, error)
	}
})
