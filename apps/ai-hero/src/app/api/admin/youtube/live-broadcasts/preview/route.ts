import { NextRequest, NextResponse } from 'next/server'
import {
	buildCreatePreview,
	requireCreateConfirmation,
	toCreateYouTubeLiveBroadcastInput,
	YouTubeLiveBroadcastCreateBodySchema,
} from '@/lib/youtube-live-admin'
import { listYouTubeLiveStreams } from '@/lib/youtube-live-broadcasts'
import { withSkill } from '@/server/with-skill'

import {
	buildTelemetry,
	forbiddenResponse,
	getYouTubeLiveAdminAuth,
	logFailedOperation,
	logInfoSafely,
	payloadTelemetry,
	unauthorizedResponse,
	upstreamErrorResponse,
	validationErrorResponse,
	youtubeLiveCorsHeaders,
} from '../_utils'

const endpoint = '/api/admin/youtube/live-broadcasts/preview'

export const OPTIONS = () =>
	NextResponse.json({}, { headers: youtubeLiveCorsHeaders })

async function resolveStream(streamId?: string) {
	const streams = await listYouTubeLiveStreams()
	if (streamId) {
		return streams.find((stream) => stream.id === streamId) ?? null
	}

	return streams.find((stream) => stream.title === 'Default stream key') ?? null
}

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

	await logInfoSafely('youtube.live.broadcast.create.preview.requested', () =>
		buildTelemetry(request, auth, {
			operation: 'create.preview',
			confirmed: requireCreateConfirmation(parsed.data),
			...payloadTelemetry(payload),
		}),
	)

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

		const preview = buildCreatePreview(parsed.data, stream)
		await logInfoSafely('youtube.live.broadcast.create.preview.succeeded', () =>
			buildTelemetry(request, auth, {
				operation: 'create.preview',
				durationMs: Date.now() - startedAt,
				resolvedStreamId: stream.id,
				streamTitle: stream.title,
				streamStatus: stream.streamStatus,
				streamHealthStatus: stream.healthStatus,
				...payloadTelemetry(payload),
			}),
		)

		return NextResponse.json(
			{
				ok: true,
				endpoint,
				preview,
			},
			{ headers: youtubeLiveCorsHeaders },
		)
	} catch (error) {
		await logFailedOperation(
			'youtube.live.broadcast.create.preview.failed',
			request,
			auth,
			error,
			{
				operation: 'create.preview',
				durationMs: Date.now() - startedAt,
				...payloadTelemetry(payload),
			},
		)
		return upstreamErrorResponse(endpoint, error)
	}
})
