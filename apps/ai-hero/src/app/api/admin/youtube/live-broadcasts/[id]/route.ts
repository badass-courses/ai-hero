import { NextRequest, NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import {
	buildUpdatePreview,
	requireUpdateConfirmation,
	toUpdateYouTubeLiveBroadcastInput,
	toYouTubeLiveBroadcastReceipt,
	validateEffectiveUpdateTimes,
	YouTubeLiveBroadcastUpdateBodySchema,
} from '@/lib/youtube-live-admin'
import {
	getYouTubeLiveBroadcast,
	updateYouTubeLiveBroadcast,
} from '@/lib/youtube-live-broadcasts'
import { withSkill } from '@/server/with-skill'

import {
	buildTelemetry,
	conflictResponse,
	forbiddenResponse,
	getYouTubeLiveAdminAuth,
	flushLogsSafely,
	logFailedOperation,
	logInfoSafely,
	notFoundResponse,
	payloadTelemetry,
	unauthorizedResponse,
	upstreamErrorResponse,
	validationErrorResponse,
	youtubeLiveCorsHeaders,
} from '../_utils'

const endpointFor = (id: string) =>
	`/api/admin/youtube/live-broadcasts/${encodeURIComponent(id)}`

export const OPTIONS = () =>
	NextResponse.json({}, { headers: youtubeLiveCorsHeaders })

export const GET = withSkill(
	async (
		request: NextRequest,
		{ params }: { params: Promise<{ id: string }> },
	) => {
		const { id } = await params
		const endpoint = endpointFor(id)
		const auth = await getYouTubeLiveAdminAuth(request)
		if (!auth.user) return unauthorizedResponse(endpoint)
		if (!auth.authorized) return forbiddenResponse(endpoint)

		const startedAt = Date.now()
		await logInfoSafely('youtube.live.broadcast.get.started', () =>
			buildTelemetry(request, auth, {
				operation: 'get',
				broadcastId: id,
			}),
		)

		try {
			const broadcast = await getYouTubeLiveBroadcast(id)
			if (!broadcast) return notFoundResponse(endpoint, id)

			await logInfoSafely('youtube.live.broadcast.get.succeeded', () =>
				buildTelemetry(request, auth, {
					operation: 'get',
					durationMs: Date.now() - startedAt,
					...payloadTelemetry(broadcast),
				}),
			)

			return NextResponse.json(
				{
					ok: true,
					endpoint,
					broadcast: toYouTubeLiveBroadcastReceipt(broadcast),
				},
				{ headers: youtubeLiveCorsHeaders },
			)
		} catch (error) {
			await logFailedOperation(
				'youtube.live.broadcast.get.failed',
				request,
				auth,
				error,
				{
					operation: 'get',
					broadcastId: id,
					durationMs: Date.now() - startedAt,
				},
			)
			return upstreamErrorResponse(endpoint, error)
		}
	},
)

export const PATCH = withSkill(
	async (
		request: NextRequest,
		{ params }: { params: Promise<{ id: string }> },
	) => {
		const { id } = await params
		const endpoint = endpointFor(id)
		const auth = await getYouTubeLiveAdminAuth(request)
		if (!auth.user) return unauthorizedResponse(endpoint)
		if (!auth.authorized) return forbiddenResponse(endpoint)

		const body = await request.json().catch(() => null)
		const parsed = YouTubeLiveBroadcastUpdateBodySchema.safeParse(body)
		if (!parsed.success) {
			return validationErrorResponse(endpoint, parsed.error.format())
		}

		const payload = toUpdateYouTubeLiveBroadcastInput(id, parsed.data)
		const startedAt = Date.now()
		await logInfoSafely('youtube.live.broadcast.update.requested', () =>
			buildTelemetry(request, auth, {
				operation: 'update',
				confirmed: requireUpdateConfirmation(parsed.data),
				...payloadTelemetry(payload),
			}),
		)

		if (!requireUpdateConfirmation(parsed.data)) {
			return conflictResponse(
				endpoint,
				'CONFIRMATION_REQUIRED',
				'confirm must equal UPDATE_YOUTUBE_BROADCAST',
			)
		}

		try {
			const current = await getYouTubeLiveBroadcast(id)
			if (!current) return notFoundResponse(endpoint, id)

			if (!validateEffectiveUpdateTimes(parsed.data, current)) {
				return validationErrorResponse(endpoint, {
					scheduledEndTime: [
						'effective scheduledEndTime must be after effective scheduledStartTime',
					],
				})
			}

			const updated = await updateYouTubeLiveBroadcast(payload)
			revalidateTag('youtube-live-broadcasts', 'max')
			revalidateTag('youtube-live-broadcasts-active', 'max')

			await logInfoSafely('youtube.live.broadcast.update.succeeded', () =>
				buildTelemetry(request, auth, {
					operation: 'update',
					confirmed: true,
					durationMs: Date.now() - startedAt,
					previous: payloadTelemetry(current),
					...payloadTelemetry(updated),
				}),
			)
			await flushLogsSafely()

			return NextResponse.json(
				{
					ok: true,
					endpoint,
					broadcast: toYouTubeLiveBroadcastReceipt(updated),
				},
				{ headers: youtubeLiveCorsHeaders },
			)
		} catch (error) {
			await logFailedOperation(
				'youtube.live.broadcast.update.failed',
				request,
				auth,
				error,
				{
					operation: 'update',
					confirmed: true,
					durationMs: Date.now() - startedAt,
					...payloadTelemetry(payload),
				},
			)
			return upstreamErrorResponse(endpoint, error)
		}
	},
)
