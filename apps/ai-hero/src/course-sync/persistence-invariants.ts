import { stableJson } from './control-plane'
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
 * decision, so ordinary creates, updates, moves and detaches apply without a
 * human gate. A lesson demotion or lost video requires operator review.
 */
export function evaluateCourseSyncBoundedAutoApply(
	plan: SyncPlan,
): CourseSyncBoundedAutoApplyDecision {
	const placeholderUpdate = plan.resources.some(
		(item) =>
			item.sourceKind === 'lesson' &&
			item.action !== 'create' &&
			(item.fields.courseSync as { lessonType?: unknown } | undefined)
				?.lessonType === 'placeholder',
	)
	const lostVideo = plan.resources.some(
		(item) =>
			(item.sourceKind === 'video' || item.sourceKind === 'solution') &&
			item.detached === true &&
			item.previousDetached !== true,
	)
	if (plan.lessonRegressions === undefined && placeholderUpdate) {
		return {
			eligible: false,
			planSha256: plan.planSha256,
			reason: 'Preview predates lesson regression tracking; re-preview or apply as operator.',
			failureCode: 'LEGACY_PLACEHOLDER_PREVIEW_REVIEW_REQUIRED',
		}
	}
	if (plan.lessonRegressions?.length) {
		return {
			eligible: false,
			planSha256: plan.planSha256,
			reason: `Lesson regressions require operator review: ${plan.lessonRegressions.join(', ')}`,
			failureCode: 'LESSON_REGRESSION_REVIEW_REQUIRED',
		}
	}
	if (lostVideo) {
		return {
			eligible: false,
			planSha256: plan.planSha256,
			reason: 'A managed video or solution is being detached.',
			failureCode: 'LOST_VIDEO_REVIEW_REQUIRED',
		}
	}
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

export function verifyCourseSyncActivation(
	plan: SyncPlan,
	receipts: ReadonlyArray<{ resourceId: string; contentResourceVersionId: string }>,
	resources: ReadonlyArray<{
		id: string
		currentVersionId: string | null
		fields: Record<string, unknown> | null
	}>,
	relations: ReadonlyArray<{
		resourceId: string
		resourceOfId: string
		position: number
		deletedAt: Date | null
	}>,
	expectedDeletedAtByResource: ReadonlyMap<string, Date>,
): { ok: true } | { ok: false; resourceId: string; reason: string } {
	if (resources.length !== plan.resources.length) {
		return { ok: false, resourceId: '', reason: 'resource_count_mismatch' }
	}
	const receiptById = new Map(receipts.map((receipt) => [receipt.resourceId, receipt]))
	const resourceById = new Map(resources.map((resource) => [resource.id, resource]))
	for (const item of plan.resources) {
		const resourceId = item.targetResourceId
		const resource = resourceById.get(resourceId)
		const receipt = receiptById.get(resourceId)
		if (!resource || !receipt) {
			return { ok: false, resourceId, reason: 'resource_or_receipt_missing' }
		}
		if (resource.currentVersionId !== receipt.contentResourceVersionId) {
			return { ok: false, resourceId, reason: 'pointer_mismatch' }
		}
		if (stableJson(resource.fields ?? {}) !== stableJson(item.fields)) {
			return { ok: false, resourceId, reason: 'fields_mismatch' }
		}
		const rows = relations.filter((relation) => relation.resourceId === resourceId)
		const live = rows.filter((relation) => relation.deletedAt === null)
		const matchingDead = rows.filter(
			(relation) =>
				relation.deletedAt !== null &&
				relation.resourceOfId === item.parentResourceId &&
				relation.position === item.position,
		)
		// The relation column is TIMESTAMP(3), matching JS Date millisecond precision.
		// Compare the value promoted by this apply, not merely any old tombstone.
		const expectedDeletedAt = expectedDeletedAtByResource.get(resourceId)
		const relationMatches = item.detached
			? live.length === 0 &&
				matchingDead.length === 1 &&
				expectedDeletedAt !== undefined &&
				matchingDead[0]?.deletedAt instanceof Date &&
				matchingDead[0].deletedAt.getTime() === expectedDeletedAt.getTime()
			: live.length === 1 &&
					live[0]?.resourceOfId === item.parentResourceId &&
					live[0]?.position === item.position
		if (!relationMatches) {
			return { ok: false, resourceId, reason: 'relation_mismatch' }
		}
	}
	return { ok: true }
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
