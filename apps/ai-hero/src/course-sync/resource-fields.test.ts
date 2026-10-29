import { describe, expect, it } from 'vitest'

import {
	courseSyncSourceFields,
	mergeCourseSyncResourceFields,
} from './resource-fields'
import { AI_HERO_COURSE_SYNC_BINDING_COHORT_005 as v8, AI_HERO_COURSE_SYNC_BINDING_COHORT_005_V7 as v7, AI_HERO_COURSE_SYNC_BINDING as crash, managedResourceStateAllowed, type ResourcePlanItem } from './types'
import { resolveCourseSyncRollbackFields } from './persistence-invariants'

const schedule = {
	startsAt: '2026-11-09T08:01:00.000Z',
	endsAt: null,
	timezone: 'America/Los_Angeles',
	releasePolicy: { mode: 'scheduled' },
}

describe('course-sync field ownership', () => {
	it('only v8 workshop state is excluded from source drift and preserved on merge', () => {
		const fields = { state: 'draft', visibility: 'unlisted', title: 'New' }
		const published = { ...fields, state: 'published' }
		for (const binding of [v7, crash]) {
			expect(courseSyncSourceFields('workshop', published, binding)).toEqual(published)
			expect(mergeCourseSyncResourceFields({ sourceKind: 'workshop', fields }, published, binding).state).toBe('draft')
			expect(managedResourceStateAllowed(binding, 'workshop', 'published')).toBe(false)
		}
		expect(courseSyncSourceFields('workshop', published, v8)).toEqual({ visibility: 'unlisted', title: 'New' })
		expect(mergeCourseSyncResourceFields({ sourceKind: 'workshop', fields }, published, v8).state).toBe('published')
		expect(mergeCourseSyncResourceFields({ sourceKind: 'workshop', fields }, {}, v8).state).toBe('draft')
		expect(managedResourceStateAllowed(v8, 'workshop', 'published')).toBe(true)
		for (const sourceKind of ['lesson', 'section', 'solution', 'question'] as const) {
			expect(managedResourceStateAllowed(v8, sourceKind, 'published')).toBe(false)
			expect(courseSyncSourceFields(sourceKind, published, v8)).toHaveProperty('state', 'published')
		}
		expect(managedResourceStateAllowed(v8, 'video', 'ready')).toBe(true)
		expect(managedResourceStateAllowed(v8, 'video', 'published')).toBe(false)
	})

	it('create rollback preserves release state while marking the workshop inactive', () => {
		expect(resolveCourseSyncRollbackFields({ binding: v8, action: 'create', sourceKind: 'workshop', currentFields: { state: 'published', visibility: 'unlisted' }, previousVersionFields: null, runId: 'run-test' })).toMatchObject({ state: 'published', courseSync: { active: false } })
	})
	it.each<ResourcePlanItem['sourceKind']>([
		'section',
		'workshop',
		'lesson',
		'solution',
		'video',
		'question',
	])(
		'preserves non-source fields on %s and excludes them from drift',
		(sourceKind) => {
			const fields = {
				state: 'draft',
				visibility: 'unlisted',
				courseSync: { bindingId: 'test' },
			}
			const existing = { ...fields, ...schedule, operatorNote: 'Keep' }
			expect(courseSyncSourceFields(sourceKind, existing)).toEqual(fields)
			expect(
				mergeCourseSyncResourceFields({ sourceKind, fields }, existing),
			).toEqual(existing)
			expect(mergeCourseSyncResourceFields({ sourceKind, fields })).toEqual(
				fields,
			)
		},
	)

	it('removes absent source-owned optional question fields without losing scheduling', () => {
		const fields = {
			question: 'Updated?',
			type: 'multiple-choice',
			correct: ['yes'],
			choices: [{ label: 'Yes', value: 'yes' }],
		}
		expect(
			mergeCourseSyncResourceFields(
				{ sourceKind: 'question', fields },
				{
					...schedule,
					question: 'Before?',
					correct: 'no',
					answer: 'Old explanation',
					dependsOn: { question: 'old', answer: 'old' },
				},
			),
		).toEqual({ ...schedule, ...fields })
	})

	it('takes operator edits and deletions from the row, never from the source plan', () => {
		expect(
			mergeCourseSyncResourceFields(
				{ sourceKind: 'workshop', fields: { title: 'Updated' } },
				{ title: 'Before', startsAt: null, timezone: 'UTC' },
			),
		).toEqual({ title: 'Updated', startsAt: null, timezone: 'UTC' })
	})

	it('throws instead of silently dropping an unmapped produced key', () => {
		expect(() =>
			mergeCourseSyncResourceFields(
				{
					sourceKind: 'workshop',
					fields: { title: 'Updated', newlyProducedField: 'Do not lose' },
				},
				schedule,
			),
		).toThrowError(
			expect.objectContaining({
				code: 'SOURCE_FIELD_OWNERSHIP_MISMATCH',
				retryable: false,
			}),
		)
	})
})
