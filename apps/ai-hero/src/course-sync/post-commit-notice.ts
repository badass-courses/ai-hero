import type { CourseSyncRunSummary } from '@ai-hero/course-sync-schema'

import { log } from '@/server/logger'

import {
	claimCourseSyncReviewNotification,
	failCourseSyncReviewNotification,
	type CourseSyncNotificationKind,
} from './detection-persistence'
import { getServerCourseSyncBinding } from './types'

type Phase = 'apply' | 'rollback'

/**
 * A committed operation must not become a failed HTTP response because its
 * post-commit notice lookup failed. Claim then fail the same lifecycle receipt
 * used by the deliverer: repeating the operation with its original idempotency
 * key can redeliver, and the next claim accepts a failed receipt.
 */
export async function recordPostCommitNoticeFailure(input: {
	run: CourseSyncRunSummary
	phase: Phase
	error: unknown
}): Promise<void> {
	const { run, phase, error } = input
	const failureClass =
		phase === 'apply'
			? 'APPLIED_NOTICE_BINDING_LOOKUP_FAILED'
			: 'COHORT_ENTITLEMENT_BINDING_LOOKUP_FAILED'
	let receiptRecorded = false
	let receiptError: string | null = null
	try {
		// Rollback has no entitlement delivery for v4. This bindingId is from
		// the committed run result, used only to classify the fallback receipt;
		// successful delivery always re-reads the persisted run by ID.
		const kind: CourseSyncNotificationKind =
			phase === 'apply' ? 'applied' : 'entitlement-rolled-back'
		const shouldRecord =
			phase === 'apply' ||
			getServerCourseSyncBinding(run.bindingId).contractVersion === 5
		if (shouldRecord) {
			if (!run.planSha256)
				throw new Error('Committed run has no plan hash for notice receipt')
			const receipt = {
				kind,
				bindingId: run.bindingId,
				courseVersionId: run.courseVersionId,
				// The receipt key uses kind, binding, version and plan hash. The
				// eventual deliverer replaces this fallback with the source revision.
				providerRevision: run.courseVersionId,
				runId: run.runId,
				controlPlaneRunId: run.runId,
				planSha256: run.planSha256,
				occurredAt: new Date(),
			}
			if (await claimCourseSyncReviewNotification(receipt)) {
				await failCourseSyncReviewNotification({ ...receipt, failureClass })
				receiptRecorded = true
			}
		}
	} catch (cause) {
		receiptError = cause instanceof Error ? cause.message : String(cause)
	}
	await log
		.error('course_sync.post_commit_notice.lookup_failed', {
			runId: run.runId,
			phase,
			bindingId: run.bindingId,
			failureClass,
			receiptRecorded,
			...(receiptError ? { receiptError } : {}),
			error: error instanceof Error ? error.message : String(error),
		})
		.catch(() => undefined)
}
