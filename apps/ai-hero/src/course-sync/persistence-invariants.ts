import { CourseSyncError } from './errors'
import {
	AI_HERO_COURSE_SYNC_BINDING,
	type CourseSyncBinding,
	type ResourcePlanItem,
	type SyncPlan,
} from './types'

export const COURSE_SYNC_APPLY_BATCH_SIZE = 50

const AI_HERO_MANAGED_RESOURCE_COUNTS = {
	section: 6,
	lesson: 59,
	solution: 11,
	video: 70,
	question: 87,
} as const

const AI_HERO_MANAGED_MEDIA_COUNT = 70
export const COURSE_SYNC_BOUNDED_AUTO_MAX_RESOURCE_UPDATES = 50
export const COURSE_SYNC_BOUNDED_AUTO_MAX_MEDIA_UPDATES = 25

export type CourseSyncBoundedAutoApplyDecision =
	| { eligible: true; planSha256: string }
	| {
			eligible: false
			planSha256: string
			reason: 'launch-policy-violation' | 'change-budget-exceeded'
			failureCode: string
	  }

export function assertCourseSyncLaunchApplyPolicy(plan: SyncPlan): void {
	const resourceCounts = Object.fromEntries(
		(['section', 'lesson', 'solution', 'video', 'question'] as const).map(
			(sourceKind) => [
				sourceKind,
				{
					update: plan.resources.filter(
						(item) =>
							item.sourceKind === sourceKind && item.action === 'update',
					).length,
					retain: plan.resources.filter(
						(item) =>
							item.sourceKind === sourceKind && item.action === 'retain',
					).length,
				},
			],
		),
	) as Record<
		keyof typeof AI_HERO_MANAGED_RESOURCE_COUNTS,
		{ update: number; retain: number }
	>
	const mediaCounts = {
		update: plan.media.filter((item) => item.action === 'update').length,
		retain: plan.media.filter((item) => item.action === 'retain').length,
	}
	const topologyChanged = plan.resources.some(
		(item) =>
			item.action === 'create' ||
			item.previousVersionId === null ||
			item.previousFieldsSha256 === null ||
			item.previousParentResourceId !== item.parentResourceId ||
			item.previousPosition !== item.position ||
			item.previousDetached !== item.detached ||
			item.detached,
	)
	const resourceInventoryMatches = Object.entries(
		AI_HERO_MANAGED_RESOURCE_COUNTS,
	).every(([sourceKind, expected]) => {
		const actual =
			resourceCounts[sourceKind as keyof typeof AI_HERO_MANAGED_RESOURCE_COUNTS]
		return actual.update + actual.retain === expected
	})
	const mediaInventoryMatches =
		mediaCounts.update + mediaCounts.retain === AI_HERO_MANAGED_MEDIA_COUNT
	const mediaReady = plan.media.every(
		(item) =>
			item.muxAssetId.trim().length > 0 &&
			item.muxPlaybackId.trim().length > 0 &&
			Number.isFinite(item.duration) &&
			item.duration > 0 &&
			Number.isInteger(item.bytes) &&
			item.bytes > 0 &&
			item.sha256.trim().length > 0,
	)
	if (
		plan.bindingId !== AI_HERO_COURSE_SYNC_BINDING.bindingId ||
		topologyChanged ||
		!resourceInventoryMatches ||
		!mediaInventoryMatches ||
		!mediaReady
	) {
		throw new CourseSyncError(
			'LAUNCH_APPLY_POLICY_VIOLATION',
			'Apply blocked: the plan is outside the managed, topology-preserving, asset-ready 6-section, 59-lesson, 11-solution, 70-video, 87-question course shape.',
			409,
			{
				category: 'target_precondition',
				retryable: false,
				details: {
					resourceCounts,
					mediaCounts,
					topologyChanged,
					mediaReady,
				},
			},
		)
	}
}

export function evaluateCourseSyncBoundedAutoApply(
	plan: SyncPlan,
): CourseSyncBoundedAutoApplyDecision {
	try {
		assertCourseSyncLaunchApplyPolicy(plan)
		const resourceUpdates = plan.resources.filter(
			(item) => item.action === 'update',
		).length
		const mediaUpdates = plan.media.filter(
			(item) => item.action === 'update',
		).length
		if (
			resourceUpdates > COURSE_SYNC_BOUNDED_AUTO_MAX_RESOURCE_UPDATES ||
			mediaUpdates > COURSE_SYNC_BOUNDED_AUTO_MAX_MEDIA_UPDATES
		) {
			return {
				eligible: false,
				planSha256: plan.planSha256,
				reason: 'change-budget-exceeded',
				failureCode: 'BOUNDED_AUTO_CHANGE_BUDGET_EXCEEDED',
			}
		}
		return { eligible: true, planSha256: plan.planSha256 }
	} catch (error) {
		if (
			error instanceof CourseSyncError &&
			error.code === 'LAUNCH_APPLY_POLICY_VIOLATION'
		) {
			return {
				eligible: false,
				planSha256: plan.planSha256,
				reason: 'launch-policy-violation',
				failureCode: error.code,
			}
		}
		throw error
	}
}

export function resolveCourseSyncRollbackFields(input: {
	action: ResourcePlanItem['action']
	sourceKind: ResourcePlanItem['sourceKind']
	currentFields: Record<string, unknown>
	previousVersionFields: Record<string, unknown> | null
	runId: string
}): Record<string, unknown> {
	if (input.action === 'retain') return input.currentFields
	if (input.action === 'update') {
		if (!input.previousVersionFields) {
			throw new CourseSyncError(
				'ROLLBACK_PARENT_VERSION_MISSING',
				'An updated resource has no previous version fields to restore.',
				409,
				{ category: 'lifecycle_conflict', retryable: false },
			)
		}
		return input.previousVersionFields
	}
	const courseSync = input.currentFields.courseSync as
		| Record<string, unknown>
		| undefined
	return {
		...input.currentFields,
		state: input.sourceKind === 'video' ? 'deleted' : 'draft',
		visibility: 'unlisted',
		courseSync: {
			...courseSync,
			active: false,
			rollbackOfRunId: input.runId,
		},
	}
}

export function courseSyncRollbackPointer(input: {
	resourceId: string
	resourceType: string
	createdById: string
	versionId: string
	fields: Record<string, unknown>
}) {
	return {
		id: input.resourceId,
		type: input.resourceType,
		createdById: input.createdById,
		currentVersionId: input.versionId,
		fields: input.fields,
	}
}

export function chunkCourseSyncWrites<T>(
	values: ReadonlyArray<T>,
	size = COURSE_SYNC_APPLY_BATCH_SIZE,
): T[][] {
	if (!Number.isInteger(size) || size < 1) {
		throw new Error('Chunk size must be positive.')
	}
	const chunks: T[][] = []
	for (let index = 0; index < values.length; index += size) {
		chunks.push(values.slice(index, index + size))
	}
	return chunks
}

export function assertManagedChildRelations(
	binding: CourseSyncBinding,
	childRelations: ReadonlyArray<{
		position: number
		resource?: { type: string; fields: unknown } | null
	}>,
) {
	const positions = childRelations.map((child) => child.position)
	if (
		new Set(positions).size !== positions.length ||
		positions.some((position) => !Number.isInteger(position) || position < 0)
	) {
		throw new CourseSyncError(
			'TARGET_CHILD_SCOPE_WIDENED',
			'The bound workshop does not have one unique non-negative slot per managed section.',
			409,
		)
	}
	for (const child of childRelations) {
		const fields = child.resource?.fields as Record<string, unknown> | undefined
		const sync = fields?.courseSync as Record<string, unknown> | undefined
		if (
			child.resource?.type !== 'section' ||
			fields?.state !== binding.managedChildContract.state ||
			fields.visibility !== binding.managedChildContract.visibility ||
			sync?.bindingId !== binding.bindingId
		) {
			throw new CourseSyncError(
				'TARGET_CHILD_SCOPE_WIDENED',
				'The bound workshop contains a relation outside the managed sections.',
				409,
			)
		}
	}
}
