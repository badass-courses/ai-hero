import type { CourseSyncStalePreviewData } from '@/inngest/events/course-sync-stale-preview'
import type { CourseSyncDetectionPollerDependencies } from './detection-poller'

type Dependencies = Pick<
	CourseSyncDetectionPollerDependencies,
	| 'getPollState'
	| 'getRun'
	| 'evaluateBoundedAutoApply'
	| 'claimReviewNotification'
	| 'completeReviewNotification'
	| 'failReviewNotification'
	| 'notify'
	| 'appendLog'
> & { clock?: () => Date }

/** Durable lifecycle: scheduled → sleeping → rechecked → skipped | claimed → delivered.
 * The Inngest worker owns the sleep; the existing poll state owns apply/hold.
 */
export async function remindStaleCourseSyncPreview(
	input: CourseSyncStalePreviewData,
	dependencies: Dependencies,
) {
	const now = (dependencies.clock ?? (() => new Date()))()
	const minutesWaiting = Math.floor(
		(now.getTime() - new Date(input.heldAt).getTime()) / 60_000,
	)
	if (!Number.isFinite(minutesWaiting) || minutesWaiting < 15)
		return { reminded: false, reason: 'not-due' }
	const state = await dependencies.getPollState(input.bindingId)
	if (
		state?.status !== 'awaiting-apply' ||
		state.controlPlaneRunId !== input.controlPlaneRunId ||
		state.courseVersionId !== input.courseVersionId
	) {
		return { reminded: false, reason: 'no-longer-awaiting-this-run' }
	}
	const run = await dependencies.getRun(input.controlPlaneRunId)
	if (run.state !== 'previewed' || run.planSha256 !== input.planSha256)
		return { reminded: false, reason: 'preview-changed' }
	const decision = await dependencies.evaluateBoundedAutoApply(
		input.controlPlaneRunId,
	)
	if (decision.planSha256 !== input.planSha256)
		return { reminded: false, reason: 'preview-changed' }
	const reasonCode = decision.eligible
		? 'OPERATOR_APPLY_REQUIRED'
		: decision.failureCode
	const humanReason = decision.eligible
		? 'Waiting for operator apply.'
		: decision.reason
	const receipt = {
		kind: 'stale-preview' as const,
		bindingId: input.bindingId,
		courseVersionId: input.courseVersionId,
		providerRevision: state.providerRevision,
		runId: `stale:${input.controlPlaneRunId}`,
		controlPlaneRunId: input.controlPlaneRunId,
		planSha256: input.planSha256,
		occurredAt: now,
	}
	if (!(await dependencies.claimReviewNotification(receipt)))
		return { reminded: false, reason: 'already-claimed' }
	try {
		await dependencies.notify({
			kind: 'review',
			courseVersionId: input.courseVersionId,
			courseName: null,
			providerRevision: state.providerRevision,
			manifestSha256: null,
			runId: receipt.runId,
			controlPlaneRunId: input.controlPlaneRunId,
			resourceCounts: run.resourceCounts,
			mediaCount:
				run.plan?.media.filter((item) => item.action !== 'retain').length ?? 0,
			planSha256: input.planSha256,
			autoApplyReason: humanReason,
			reasonCode,
			affectedLessons: decision.eligible ? undefined : decision.affectedLessons,
			minutesWaiting,
		})
	} catch (error) {
		await dependencies.failReviewNotification({
			...receipt,
			failureClass: 'STALE_PREVIEW_NOTICE_FAILED',
		})
		throw error
	}
	await dependencies.completeReviewNotification(receipt)
	await dependencies.appendLog({
		...receipt,
		stage: 'notify',
		outcome: 'succeeded',
		metadata: {
			reason: 'course-sync.stale-preview',
			reasonCode,
			humanReason,
			minutesWaiting,
			planSha256: input.planSha256,
		},
	})
	return { reminded: true }
}
