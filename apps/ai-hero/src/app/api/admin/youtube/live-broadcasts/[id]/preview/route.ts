import { NextRequest, NextResponse } from 'next/server'
import {
	buildUpdatePreview,
	requireUpdateConfirmation,
	toUpdateYouTubeLiveBroadcastInput,
	validateEffectiveUpdateTimes,
	YouTubeLiveBroadcastUpdateBodySchema,
} from '@/lib/youtube-live-admin'
import { getYouTubeLiveBroadcast } from '@/lib/youtube-live-broadcasts'
import { withSkill } from '@/server/with-skill'

import {
	buildTelemetry,
	forbiddenResponse,
	getYouTubeLiveAdminAuth,
	logFailedOperation,
	logInfoSafely,
	notFoundResponse,
	payloadTelemetry,
	unauthorizedResponse,
	upstreamErrorResponse,
	validationErrorResponse,
	youtubeLiveCorsHeaders,
} from '../../_utils'

const endpointFor = (id: string) =>
	`/api/admin/youtube/live-broadcasts/${encodeURIComponent(id)}/preview`

export const OPTIONS = () =>
	NextResponse.json({}, { headers: youtubeLiveCorsHeaders })

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
		await logInfoSafely('youtube.live.broadcast.update.preview.requested', () =>
			buildTelemetry(request, auth, {
				operation: 'update.preview',
				confirmed: requireUpdateConfirmation(parsed.data),
				...payloadTelemetry(payload),
			}),
		)

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

			const preview = buildUpdatePreview(id, parsed.data, current)
			await logInfoSafely(
				'youtube.live.broadcast.update.preview.succeeded',
				() =>
					buildTelemetry(request, auth, {
						operation: 'update.preview',
						durationMs: Date.now() - startedAt,
						previous: payloadTelemetry(current),
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
				'youtube.live.broadcast.update.preview.failed',
				request,
				auth,
				error,
				{
					operation: 'update.preview',
					durationMs: Date.now() - startedAt,
					...payloadTelemetry(payload),
				},
			)
			return upstreamErrorResponse(endpoint, error)
		}
	},
)
