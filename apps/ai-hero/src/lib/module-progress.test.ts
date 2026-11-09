import { describe, expect, it } from 'vitest'

import { summarizeModuleProgressRows } from './module-progress'

describe('summarizeModuleProgressRows', () => {
	it('keeps optional completions visible but counts and advances through required lessons only', () => {
		const progress = summarizeModuleProgressRows('learner', [
			{
				resourceId: 'required-complete',
				resourceType: 'lesson',
				resourceSlug: 'required-complete',
				completedAt: new Date('2026-11-09T10:00:00.000Z'),
				optional: false,
			},
			{
				resourceId: 'optional-faq',
				resourceType: 'lesson',
				resourceSlug: 'optional-faq',
				completedAt: new Date('2026-11-09T11:00:00.000Z'),
				optional: true,
			},
			{
				resourceId: 'required-next',
				resourceType: 'lesson',
				resourceSlug: 'required-next',
				completedAt: null,
				optional: false,
			},
		])

		expect(progress.completedLessons.map((lesson) => lesson.resourceId)).toEqual([
			'required-complete',
			'optional-faq',
		])
		expect(progress.completedLessonsCount).toBe(1)
		expect(progress.totalLessonsCount).toBe(2)
		expect(progress.percentCompleted).toBe(50)
		expect(progress.nextResource?.id).toBe('required-next')
	})

	it('stays at 100 percent when an optional FAQ is added after required completion', () => {
		const progress = summarizeModuleProgressRows('cohort-005-learner', [
			{
				resourceId: 'before-we-start',
				resourceType: 'lesson',
				resourceSlug: 'before-we-start',
				completedAt: new Date('2026-11-01T10:00:00.000Z'),
				optional: false,
			},
			{
				resourceId: 'faq',
				resourceType: 'lesson',
				resourceSlug: 'faq',
				completedAt: null,
				optional: true,
			},
		])

		expect(progress.completedLessonsCount).toBe(1)
		expect(progress.totalLessonsCount).toBe(1)
		expect(progress.percentCompleted).toBe(100)
		expect(progress.nextResource).toBeNull()
	})
})
