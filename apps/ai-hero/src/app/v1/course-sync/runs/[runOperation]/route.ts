import {
	authorizeCourseSyncRequest,
	courseSyncErrorResponse,
	courseSyncJson,
	idempotencyKey,
} from '@/course-sync/http'
import { courseSyncControlPlane } from '@/course-sync/runtime'
import { requestCourseSyncAppliedNotice } from '@/course-sync/applied-notice-dispatch'
import { deliverCourseSyncEntitlementSync } from '@/course-sync/cohort-entitlements'
import { getCourseSyncRunBinding } from '@/course-sync/run-binding'
import { recordPostCommitNoticeFailure } from '@/course-sync/post-commit-notice'
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
			authorizeCourseSyncRequest(request, 'operator')
			const applied = await courseSyncControlPlane.apply({
				runId: parsed.runId,
				idempotencyKey: idempotencyKey(request),
			})
			// The team hears about an applied sync no matter who applied it. The
			// notice is a durable event rather than inline work so a slow
			// narration or a Slack outage cannot fail the operator's apply.
			if (applied.state === 'applied') {
				try {
					await requestCourseSyncAppliedNotice({
						controlPlaneRunId: applied.runId,
						requestedBy: 'operator',
					})
				} catch (error) {
					await recordPostCommitNoticeFailure({
						run: applied,
						phase: 'apply',
						error,
					})
				}
			}
			return courseSyncJson(applied)
		}
		if (parsed.operation === 'rollback') {
			authorizeCourseSyncRequest(request, 'operator')
			const rolledBack = await courseSyncControlPlane.rollback({
				runId: parsed.runId,
				idempotencyKey: idempotencyKey(request),
			})
			if (rolledBack.state === 'rolled_back') {
				try {
					if (
						(await getCourseSyncRunBinding(rolledBack.runId))
							.contractVersion === 5
					) {
						const delivery = await deliverCourseSyncEntitlementSync({
							controlPlaneRunId: rolledBack.runId,
							lifecycle: 'rolled_back',
						})
						if (delivery.reason === 'failed') {
							await recordPostCommitNoticeFailure({
								run: rolledBack,
								phase: 'rollback',
								error: new Error(
									'Cohort entitlement delivery failed after rollback',
								),
							})
						}
					}
				} catch (error) {
					await recordPostCommitNoticeFailure({
						run: rolledBack,
						phase: 'rollback',
						error,
					})
				}
			}
			return courseSyncJson(rolledBack)
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
