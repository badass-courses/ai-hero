import { CourseSyncError } from './errors'
import type { CourseSyncBinding, ResourcePlanItem } from './types'

export const COURSE_SYNC_APPLY_BATCH_SIZE = 50

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
