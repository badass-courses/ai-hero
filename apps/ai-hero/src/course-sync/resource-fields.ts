import { QuestionResourceSchema } from '@coursebuilder/survey/types'

import { CourseSyncError } from './errors'
import { preservesWorkshopReleaseState, type CourseSyncBinding, type ResourcePlanItem } from './types'

// These are keys the source may produce, including draft defaults on creation.
// v8 workshop state becomes operator-owned after creation; comparisons and merges
// below apply that exception. Scheduling keys always belong to the operator.
const commonFields = ['state', 'visibility', 'courseSync']
export const sourceFieldsByKind: Readonly<
	Record<ResourcePlanItem['sourceKind'], readonly string[]>
> = {
	section: [...commonFields, 'title', 'slug'],
	workshop: [...commonFields, 'title', 'slug'],
	lesson: [...commonFields, 'title', 'slug', 'body', 'description'],
	solution: [
		...commonFields,
		'title',
		'slug',
		'body',
		'description',
		'videoResourceId',
		'optional',
	],
	video: [
		...commonFields,
		'title',
		'duration',
		'muxAssetId',
		'muxPlaybackId',
		'chapters',
		'sessionExtract',
	],
	question: [...commonFields, ...Object.keys(QuestionResourceSchema.shape)],
}

export function courseSyncSourceFields(
	sourceKind: ResourcePlanItem['sourceKind'],
	fields: Record<string, unknown>,
	binding?: CourseSyncBinding,
): Record<string, unknown> {
	const owned = new Set(sourceFieldsByKind[sourceKind])
	if (sourceKind === 'workshop' && preservesWorkshopReleaseState(binding)) owned.delete('state')
	return Object.fromEntries(
		Object.entries(fields).filter(([key]) => owned.has(key)),
	)
}

export function assertCourseSyncSourceFields(
	item: Pick<ResourcePlanItem, 'sourceKind' | 'fields'>,
): void {
	const owned = new Set(sourceFieldsByKind[item.sourceKind])
	const unowned = Object.keys(item.fields).filter((key) => !owned.has(key))
	if (unowned.length > 0) {
		throw new CourseSyncError(
			'SOURCE_FIELD_OWNERSHIP_MISMATCH',
			`Sync produced unmapped ${item.sourceKind} fields: ${unowned.join(', ')}`,
			500,
			{ category: 'internal', retryable: false },
		)
	}
}

export function mergeCourseSyncResourceFields(
	item: Pick<ResourcePlanItem, 'sourceKind' | 'fields'>,
	existingFields: Record<string, unknown> = {},
	binding?: CourseSyncBinding,
): Record<string, unknown> {
	assertCourseSyncSourceFields(item)
	const owned = new Set(sourceFieldsByKind[item.sourceKind])
	const preserveState = item.sourceKind === 'workshop' &&
		preservesWorkshopReleaseState(binding) && existingFields.state !== undefined
	if (preserveState) owned.delete('state')
	const sourceFields = preserveState
		? courseSyncSourceFields(item.sourceKind, item.fields, binding)
		: item.fields
	return {
		...Object.fromEntries(
			Object.entries(existingFields).filter(([key]) => !owned.has(key)),
		),
		...sourceFields,
	}
}
