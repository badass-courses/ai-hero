import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { courseSyncRun, courseSyncSourceRevision } from '@/db/schema'
import { triggerCohortEntitlementSync } from '@/lib/cohort-update-trigger'
import { log } from '@/server/logger'

import {
	claimCourseSyncReviewNotification,
	completeCourseSyncReviewNotification,
	failCourseSyncReviewNotification,
} from './detection-persistence'
import { sha256, stableJson } from './control-plane'
import { CourseSyncError } from './errors'
import { getServerCourseSyncBinding, type SyncPlan } from './types'

type Lifecycle = 'applied' | 'rolled_back'
type Changes = {
	resourcesAdded: Array<{ resourceId: string; position: number }>
	resourcesRemoved: Array<{ resourceId: string }>
}

/** The plan describes forward changes. Rollback reverses only those edges. */
export function cohortWorkshopEntitlementChanges(
	plan: Pick<SyncPlan, 'resources'>,
	lifecycle: Lifecycle,
): Changes {
	const changes: Changes = { resourcesAdded: [], resourcesRemoved: [] }
	for (const item of plan.resources) {
		if (item.sourceKind !== 'workshop') continue
		const created = item.action === 'create' && !item.detached
		const detached =
			item.detached && !item.previousDetached && item.action !== 'retain'
		const reattached = !item.detached && item.previousDetached
		const added = lifecycle === 'applied' ? created || reattached : detached
		const removed = lifecycle === 'applied' ? detached : created || reattached
		if (added)
			changes.resourcesAdded.push({
				resourceId: item.targetResourceId,
				position:
					lifecycle === 'rolled_back'
						? (item.previousPosition ?? item.position)
						: item.position,
			})
		if (removed)
			changes.resourcesRemoved.push({ resourceId: item.targetResourceId })
	}
	return changes
}

/**
 * Called outside the apply transaction by both the applied-notice worker and
 * the operator rollback route. A separate per-lifecycle receipt survives
 * duplicate notice delivery; a failed receipt is retryable. The stable event
 * ID also deduplicates sends if receipt completion fails after enqueueing.
 * Trigger failure is visible in the poll log and structured error log, never as
 * a failed already-committed apply/rollback response. A missing run is an
 * inconsistent caller and is raised explicitly.
 */
export async function deliverCourseSyncEntitlementSync(input: {
	controlPlaneRunId: string
	lifecycle: Lifecycle
}): Promise<{ triggered: boolean; reason?: string }> {
	let bindingId: string | undefined
	try {
		const [run] = await db
			.select()
			.from(courseSyncRun)
			.where(eq(courseSyncRun.runId, input.controlPlaneRunId))
			.limit(1)
		if (!run) {
			throw new CourseSyncError('RUN_NOT_FOUND', 'Sync run not found.', 404)
		}
		if (run.state !== input.lifecycle || !run.plan) {
			return { triggered: false, reason: 'run-not-in-lifecycle' }
		}
		bindingId = run.bindingId
		const binding = getServerCourseSyncBinding(bindingId)
		if (binding.contractVersion !== 5)
			return { triggered: false, reason: 'not-cohort' }
		const changes = cohortWorkshopEntitlementChanges(run.plan, input.lifecycle)
		if (!changes.resourcesAdded.length && !changes.resourcesRemoved.length) {
			return { triggered: false, reason: 'no-workshop-changes' }
		}
		const [revision] = await db
			.select({ providerRevision: courseSyncSourceRevision.providerRevision })
			.from(courseSyncSourceRevision)
			.where(
				eq(courseSyncSourceRevision.sourceRevisionId, run.sourceRevisionId),
			)
			.limit(1)
		const receipt = {
			kind:
				input.lifecycle === 'applied'
					? ('entitlement-applied' as const)
					: ('entitlement-rolled-back' as const),
			bindingId,
			courseVersionId: run.courseVersionId,
			providerRevision: revision?.providerRevision ?? run.courseVersionId,
			runId: run.runId,
			controlPlaneRunId: run.runId,
			planSha256: run.planSha256 ?? run.plan.planSha256,
			occurredAt: new Date(),
		}
		if (!(await claimCourseSyncReviewNotification(receipt))) {
			return { triggered: false, reason: 'already-claimed' }
		}
		try {
			const eventId = `course-sync-entitlement-${sha256(
				stableJson({
					bindingId,
					runId: run.runId,
					lifecycle: input.lifecycle,
					planSha256: receipt.planSha256,
				}),
			)}`
			await triggerCohortEntitlementSync(
				binding.anchorCohortId,
				{
					...changes,
					// Exactly the detach set from this applied/rollback plan; [] forbids
					// every revoke even if a later cohort read is stale.
					boundedRemovals: changes.resourcesRemoved.map(
						(item) => item.resourceId,
					),
				},
				eventId,
				{ source: 'course-sync', controlPlaneRunId: run.runId },
			)
			// This receipt proves delivery, not the asynchronous workflow outcome.
			// Refusals are console.error JSON in Vercel runtime logs. Filter message
			// contains '<run-id>' AND message contains one of:
			// 'cohort_entitlement_sync.empty_target_refused',
			// 'cohort_entitlement_sync.bounded_removal_refused',
			// 'cohort_entitlement_sync.stale_snapshot_refused'.
			// A Vercel-drained Axiom dataset may also hold these lines IF configured
			// (drain unverified). Production has AXIOM_DIRECT_INGEST unset, so
			// NEXT_PUBLIC_AXIOM_DATASET is not a direct ingest sink. Setting
			// AXIOM_DIRECT_INGEST=true with AXIOM_TOKEN and a dataset enables
			// direct SDK ingest in addition to the console log.
			await completeCourseSyncReviewNotification({
				...receipt,
				occurredAt: new Date(),
			})
			return { triggered: true }
		} catch (error) {
			await failCourseSyncReviewNotification({
				...receipt,
				occurredAt: new Date(),
				failureClass: 'COHORT_ENTITLEMENT_TRIGGER_FAILED',
			}).catch(() => undefined)
			throw error
		}
	} catch (error) {
		await log
			.error('course_sync.cohort_entitlement_sync.failed', {
				bindingId: bindingId ?? null,
				controlPlaneRunId: input.controlPlaneRunId,
				lifecycle: input.lifecycle,
				error: error instanceof Error ? error.message : String(error),
			})
			.catch(() => undefined)
		if (error instanceof CourseSyncError && error.code === 'RUN_NOT_FOUND') {
			throw error
		}
		return { triggered: false, reason: 'failed' }
	}
}
