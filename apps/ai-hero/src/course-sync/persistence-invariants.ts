import { CourseSyncError } from './errors'
import {
	AI_HERO_COURSE_SYNC_BINDING,
	type CourseSyncBinding,
	type ResourcePlanItem,
	type SyncPlan,
} from './types'

export const COURSE_SYNC_APPLY_BATCH_SIZE = 50

export type CourseSyncPlanChange = {
	action: 'create' | 'update'
	sourceKind: ResourcePlanItem['sourceKind']
	title: string | null
	moved: boolean
	detached: boolean
}

export type CourseSyncBoundedAutoApplyDecision =
	| { eligible: true; planSha256: string }
	| {
			eligible: false
			planSha256: string
			reason: string
			failureCode: string
	  }

/**
 * The source manifest is authoritative. A preview that reached this point
 * already proved its own integrity: the plan hash is content-addressed, and
 * every media item was rejected at stage and preview time unless its Mux
 * asset, playback id and duration were present. Course shape is the author's
 * decision, so creates, updates, moves and detaches all apply without a human
 * gate. Reversal is an operator rollback, not a pre-approval.
 */
export function evaluateCourseSyncBoundedAutoApply(
	plan: SyncPlan,
): CourseSyncBoundedAutoApplyDecision {
	return { eligible: true, planSha256: plan.planSha256 }
}

function planChangeTitle(item: ResourcePlanItem): string | null {
	const fields = item.fields as { title?: unknown; name?: unknown }
	const candidate = fields?.title ?? fields?.name
	return typeof candidate === 'string' && candidate.trim().length > 0
		? candidate.trim()
		: null
}

/**
 * Everything the plan changed, in plan order, for humans to read. Retains are
 * omitted because a retained resource is by definition unchanged.
 */
export function summarizeCourseSyncPlanChanges(
	plan: SyncPlan,
): CourseSyncPlanChange[] {
	return plan.resources
		.filter((item) => item.action !== 'retain')
		.map((item) => ({
			action: item.action === 'create' ? ('create' as const) : ('update' as const),
			sourceKind: item.sourceKind,
			title: planChangeTitle(item),
			moved:
				item.action !== 'create' &&
				(item.previousParentResourceId !== item.parentResourceId ||
					item.previousPosition !== item.position),
			detached: item.detached === true && item.previousDetached !== true,
		}))
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
