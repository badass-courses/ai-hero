import { describe, expect, it } from 'vitest'
import {
	countRequiredModuleProgress,
	type ModuleLesson,
} from './required-module-progress'
import type { ModuleProgress } from '@coursebuilder/core/schemas'

const required: ModuleLesson = {
	id: 'required',
	type: 'lesson',
	slug: 'required',
	optional: false,
}
const faq: ModuleLesson = {
	id: 'faq',
	type: 'lesson',
	slug: 'faq',
	optional: true,
}
const progress: ModuleProgress = {
	completedLessons: [
		{
			userId: 'learner',
			resourceId: 'required',
			completedAt: new Date('2026-11-01'),
		},
	],
	nextResource: null,
	percentCompleted: 100,
	completedLessonsCount: 1,
	totalLessonsCount: 1,
}

describe('required module progress', () => {
	it('preserves 100% after adding an optional FAQ', () => {
		const before = countRequiredModuleProgress(progress, [required])
		const after = countRequiredModuleProgress(
			{
				...progress,
				totalLessonsCount: 2,
				percentCompleted: 50,
				nextResource: { id: 'faq', type: 'lesson', fields: { slug: 'faq' } },
			},
			[required, faq],
		)
		expect(before.percentCompleted).toBe(100)
		expect(after).toMatchObject({
			percentCompleted: 100,
			completedLessonsCount: 1,
			totalLessonsCount: 1,
			nextResource: null,
			optionalLessonIds: ['faq'],
		})
	})
	it('returns the exact existing object when nothing is optional', () => {
		expect(countRequiredModuleProgress(progress, [required])).toBe(progress)
	})
	it('retains optional completion records without counting them, and finds required Up Next', () => {
		const completedLessons = [
			...progress.completedLessons,
			{ resourceId: 'faq', userId: 'learner', completedAt: new Date() },
		]
		const after = countRequiredModuleProgress(
			{ ...progress, completedLessons },
			[required, faq, { ...required, id: 'next', slug: 'next' }],
		)
		expect(after.completedLessons).toBe(completedLessons)
		expect(after).toMatchObject({
			percentCompleted: 50,
			completedLessonsCount: 1,
			totalLessonsCount: 2,
			nextResource: { id: 'next', fields: { slug: 'next' } },
		})
	})
	it('counts an optional-only workshop as complete without fabricating completion records', () => {
		expect(
			countRequiredModuleProgress({ ...progress, completedLessons: [] }, [faq]),
		).toMatchObject({
			percentCompleted: 100,
			totalLessonsCount: 0,
			completedLessonsCount: 0,
			completedLessons: [],
			nextResource: null,
		})
	})
	it('can lower a partial percent when only optional work was completed, but cannot revoke 100%', () => {
		expect(
			countRequiredModuleProgress(
				{
					...progress,
					completedLessons: [
						{ userId: 'learner', resourceId: 'faq', completedAt: new Date() },
					],
				},
				[required, faq],
			).percentCompleted,
		).toBe(0)
	})
})
