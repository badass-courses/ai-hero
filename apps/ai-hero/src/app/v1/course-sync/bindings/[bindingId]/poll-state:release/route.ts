import {
	appendCourseSyncPollLog,
	getCourseSyncPollState,
	saveCourseSyncPollState,
} from '@/course-sync/detection-persistence'
import { CourseSyncError } from '@/course-sync/errors'
import {
	authorizeCourseSyncRequest,
	courseSyncErrorResponse,
	courseSyncJson,
	idempotencyKey,
} from '@/course-sync/http'
import { releaseCourseSyncPollHold } from '@/course-sync/release'
import { courseSyncControlPlane } from '@/course-sync/runtime'

export async function POST(
	request: Request,
	context: { params: Promise<{ bindingId: string }> },
) {
	try {
		authorizeCourseSyncRequest(request, 'operator')
		const { bindingId } = await context.params
		const body = (await request.json().catch(() => null)) as {
			reason?: unknown
		} | null
		if (typeof body?.reason !== 'string') {
			throw new CourseSyncError(
				'RELEASE_REASON_REQUIRED',
				'A release reason is required.',
				400,
			)
		}
		const state = await releaseCourseSyncPollHold(
			{
				assertTarget: async (candidateBindingId) => {
					await courseSyncControlPlane.getBinding(candidateBindingId)
				},
				getPollState: getCourseSyncPollState,
				savePollState: saveCourseSyncPollState,
				appendLog: appendCourseSyncPollLog,
			},
			{
				bindingId,
				actor: 'operator',
				reason: body.reason,
				operationId: idempotencyKey(request),
				occurredAt: new Date(),
			},
		)
		return courseSyncJson({
			bindingId: state.bindingId,
			courseVersionId: state.courseVersionId,
			providerRevision: state.providerRevision,
			status: state.status,
			consecutiveFailures: state.consecutiveFailures,
		})
	} catch (error) {
		return courseSyncErrorResponse(error)
	}
}
