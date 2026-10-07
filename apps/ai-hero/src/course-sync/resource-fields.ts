import { QuestionResourceSchema } from '@coursebuilder/survey/types'

import type { ResourcePlanItem } from './types'

// Keep ownership aligned with sourceResourceFields. Everything else belongs to
// the operator, including startsAt, endsAt, timezone and future scheduling keys.
const commonFields = ['state', 'visibility', 'courseSync']
const sourceFieldsByKind: Record<ResourcePlanItem['sourceKind'], readonly string[]> = {
	section: [...commonFields, 'title', 'slug'],
	workshop: [...commonFields, 'title', 'slug'],
	lesson: [...commonFields, 'title', 'slug', 'body', 'description'],
	solution: [...commonFields, 'title', 'slug', 'body', 'description', 'videoResourceId', 'optional'],
	video: [...commonFields, 'title', 'duration', 'muxAssetId', 'muxPlaybackId', 'chapters'],
	question: [...commonFields, ...Object.keys(QuestionResourceSchema.shape)],
}

export function courseSyncSourceFields(
	sourceKind: ResourcePlanItem['sourceKind'],
	fields: Record<string, unknown>,
): Record<string, unknown> {
	const owned = new Set(sourceFieldsByKind[sourceKind])
	return Object.fromEntries(Object.entries(fields).filter(([key]) => owned.has(key)))
}

export function mergeCourseSyncResourceFields(
	item: Pick<ResourcePlanItem, 'sourceKind' | 'fields'>,
	existingFields: Record<string, unknown> = {},
): Record<string, unknown> {
	const owned = new Set(sourceFieldsByKind[item.sourceKind])
	return {
		...Object.fromEntries(Object.entries(existingFields).filter(([key]) => !owned.has(key))),
		...courseSyncSourceFields(item.sourceKind, item.fields),
	}
}
