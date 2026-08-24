import { env } from '@/env.mjs'
import { CourseSyncError } from '@/course-sync/errors'
import {
	authorizeCourseSyncRequest,
	courseSyncErrorResponse,
} from '@/course-sync/http'

const INNGEST_RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/

export async function POST(
	request: Request,
	context: { params: Promise<{ runOperation: string }> },
) {
	try {
		authorizeCourseSyncRequest(request, 'operator')
		const { runOperation } = await context.params
		const match = /^(?<runId>[0-9A-HJKMNP-TV-Z]{26}):cancel$/.exec(runOperation)
		const runId = match?.groups?.runId
		if (!runId || !INNGEST_RUN_ID.test(runId)) {
			throw new CourseSyncError(
				'COURSE_SYNC_INVALID_RUN_ID',
				'Invalid Inngest run ID.',
				400,
			)
		}

		const response = await fetch(
			`https://api.inngest.com/v2/runs/${encodeURIComponent(runId)}/cancel`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${env.INNGEST_SIGNING_KEY}`,
					'Content-Type': 'application/json',
				},
			},
		)
		if (!response.ok) {
			throw new CourseSyncError(
				'COURSE_SYNC_INNGEST_CANCEL_FAILED',
				`Inngest run cancellation failed (${response.status}).`,
				response.status === 404 ? 404 : 502,
			)
		}

		return Response.json({ cancelled: true, runId }, { status: 202 })
	} catch (error) {
		return courseSyncErrorResponse(error)
	}
}
