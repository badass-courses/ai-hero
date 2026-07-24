import { decodeStageSourceRevisionRequest } from '@ai-hero/course-sync-schema'
import {
	authorizeCourseSyncRequest,
	courseSyncErrorResponse,
	courseSyncJson,
	idempotencyKey,
} from '@/course-sync/http'
import { courseSyncControlPlane } from '@/course-sync/runtime'
import { CourseSyncError } from '@/course-sync/errors'

export async function POST(
	request: Request,
	context: { params: Promise<{ bindingId: string }> },
) {
	try {
		authorizeCourseSyncRequest(request, 'stage')
		const raw: unknown = await request.json()
		if (
			!raw ||
			typeof raw !== 'object' ||
			Array.isArray(raw) ||
			Object.keys(raw).some((key) => key !== 'manifest')
		) {
			throw new CourseSyncError(
				'INVALID_STAGE_REQUEST',
				'Stage accepts only a v3 manifest; target IDs are server-owned.',
			)
		}
		let body: ReturnType<typeof decodeStageSourceRevisionRequest>
		try {
			body = decodeStageSourceRevisionRequest(raw)
		} catch (error) {
			throw new CourseSyncError(
				'INVALID_STAGE_REQUEST',
				error instanceof Error ? error.message : 'Stage request validation failed.',
				400,
			)
		}
		const { bindingId } = await context.params
		return courseSyncJson(
			await courseSyncControlPlane.stage({
				bindingId,
				idempotencyKey: idempotencyKey(request),
				manifest: body.manifest,
			}),
			201,
		)
	} catch (error) {
		return courseSyncErrorResponse(error)
	}
}
