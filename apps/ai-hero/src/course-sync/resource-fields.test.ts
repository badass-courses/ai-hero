import { describe, expect, it } from 'vitest'

import { courseSyncSourceFields, mergeCourseSyncResourceFields } from './resource-fields'
import type { ResourcePlanItem } from './types'

const schedule = {
	startsAt: '2026-11-09T08:01:00.000Z',
	endsAt: null,
	timezone: 'America/Los_Angeles',
	releasePolicy: { mode: 'scheduled' },
}

describe('course-sync field ownership', () => {
	it.each<ResourcePlanItem['sourceKind']>(['section', 'workshop', 'lesson', 'solution', 'video', 'question'])(
		'preserves non-source fields on %s and excludes them from drift', (sourceKind) => {
			const fields = { state: 'draft', visibility: 'unlisted', courseSync: { bindingId: 'test' } }
			const existing = { ...fields, ...schedule, operatorNote: 'Keep' }
			expect(courseSyncSourceFields(sourceKind, existing)).toEqual(fields)
			expect(mergeCourseSyncResourceFields({ sourceKind, fields }, existing)).toEqual(existing)
			expect(mergeCourseSyncResourceFields({ sourceKind, fields })).toEqual(fields)
		},
	)

	it('removes absent source-owned optional question fields without losing scheduling', () => {
		const fields = { question: 'Updated?', type: 'multiple-choice', correct: ['yes'], choices: [{ label: 'Yes', value: 'yes' }] }
		expect(mergeCourseSyncResourceFields({ sourceKind: 'question', fields }, {
			...schedule, question: 'Before?', correct: 'no', answer: 'Old explanation', dependsOn: { question: 'old', answer: 'old' },
		})).toEqual({ ...schedule, ...fields })
	})

	it('takes operator edits and deletions from the row, never from stale plan fields', () => {
		expect(mergeCourseSyncResourceFields({ sourceKind: 'workshop', fields: {
			title: 'Updated', startsAt: 'stale', operatorNote: 'deleted',
		} }, { title: 'Before', startsAt: null, timezone: 'UTC' })).toEqual({ title: 'Updated', startsAt: null, timezone: 'UTC' })
	})
})
