import { QuestionResourceSchema } from '@coursebuilder/survey/types'

import { CourseSyncError } from './errors'
import type { ResourcePlanItem } from './types'

// Keep ownership aligned with sourceResourceFields. Everything else belongs to
// the operator, including startsAt, endsAt, timezone and future scheduling keys.
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
	],
	question: [...commonFields, ...Object.keys(QuestionResourceSchema.shape)],
}

export function courseSyncSourceFields(
	sourceKind: ResourcePlanItem['sourceKind'],
	fields: Record<string, unknown>,
): Record<string, unknown> {
	const owned = new Set(sourceFieldsByKind[sourceKind])
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
): Record<string, unknown> {
	assertCourseSyncSourceFields(item)
	const owned = new Set(sourceFieldsByKind[item.sourceKind])
	return {
		...Object.fromEntries(
			Object.entries(existingFields).filter(([key]) => !owned.has(key)),
		),
		...item.fields,
	}
}
