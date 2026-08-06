import { describe, expect, it } from 'vitest'

import { getLatestCourseLesson } from './course-resume-navigation'

type TestResource = {
	id: string
	type: string
	fields: { slug: string; title: string }
	resources: Array<{ position: number; resource: TestResource }>
}

const resource = (
	id: string,
	type: string,
	children: TestResource[] = [],
): TestResource => ({
	id,
	type,
	fields: { slug: id, title: id },
	resources: children.map((child, position) => ({ resource: child, position })),
})

describe('course resume navigation', () => {
	it('continues a purchased cohort at its most recently active lesson', () => {
		const firstLesson = resource('lesson-1', 'lesson')
		const latestLesson = resource('lesson-2', 'lesson')
		const cohort = resource('cohort-1', 'cohort', [
			resource('workshop-1', 'workshop', [firstLesson]),
			resource('workshop-2', 'workshop', [
				resource('section-2', 'section', [latestLesson]),
			]),
		])

		const destination = getLatestCourseLesson(cohort, [
			{
				resourceId: firstLesson.id,
				updatedAt: new Date('2026-08-04T12:00:00Z'),
			},
			{
				resourceId: latestLesson.id,
				updatedAt: new Date('2026-08-05T12:00:00Z'),
			},
		])

		expect(destination).toEqual({
			lesson: latestLesson,
			workshop: cohort.resources[1]?.resource,
			href: '/workshops/workshop-2/lesson-2',
		})
	})

	it('does not invent a continue lesson before the learner starts', () => {
		const workshop = resource('workshop-1', 'workshop', [
			resource('lesson-1', 'lesson'),
		])

		expect(getLatestCourseLesson(workshop, [])).toBeNull()
	})
})
