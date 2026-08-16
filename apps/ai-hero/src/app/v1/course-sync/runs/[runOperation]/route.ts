import {
	authorizeCourseSyncRequest,
	courseSyncErrorResponse,
	courseSyncJson,
	idempotencyKey,
} from '@/course-sync/http'
import { courseSyncControlPlane } from '@/course-sync/runtime'
import { CourseSyncError } from '@/course-sync/errors'

function parseOperation(value: string) {
	const match =
		/^(?<runId>[^:]+)(?::(?<operation>preview|apply|rollback))?$/.exec(value)
	if (!match?.groups?.runId) {
		throw new CourseSyncError(
			'INVALID_RUN_OPERATION',
			'Invalid sync run operation.',
			404,
		)
	}
	return {
		runId: match.groups.runId,
		operation: match.groups.operation as
			| 'preview'
			| 'apply'
			| 'rollback'
			| undefined,
	}
}

export async function GET(
	request: Request,
	context: { params: Promise<{ runOperation: string }> },
) {
	try {
		authorizeCourseSyncRequest(request, 'read')
		const parsed = parseOperation((await context.params).runOperation)
		if (parsed.operation) {
			throw new CourseSyncError('RUN_NOT_FOUND', 'Sync run not found.', 404)
		}
		return courseSyncJson(await courseSyncControlPlane.getRun(parsed.runId))
	} catch (error) {
		return courseSyncErrorResponse(error)
	}
}

export async function POST(
	request: Request,
	context: { params: Promise<{ runOperation: string }> },
) {
	try {
		const parsed = parseOperation((await context.params).runOperation)
		if (parsed.operation === 'preview') {
			authorizeCourseSyncRequest(request, 'worker')
			return courseSyncJson(await courseSyncControlPlane.preview(parsed.runId))
		}
		if (parsed.operation === 'apply') {
			authorizeCourseSyncRequest(request, ['worker', 'operator'])
			return courseSyncJson(
				await courseSyncControlPlane.apply({
					runId: parsed.runId,
					idempotencyKey: idempotencyKey(request),
				}),
			)
		}
		if (parsed.operation === 'rollback') {
			authorizeCourseSyncRequest(request, 'operator')
			return courseSyncJson(
				await courseSyncControlPlane.rollback({
					runId: parsed.runId,
					idempotencyKey: idempotencyKey(request),
				}),
			)
		}
		throw new CourseSyncError(
			'INVALID_RUN_OPERATION',
			'Invalid sync run operation.',
			404,
		)
	} catch (error) {
		return courseSyncErrorResponse(error)
	}
}
