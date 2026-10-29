import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getLesson: vi.fn(),
	getLessonVideoTranscript: vi.fn(),
	getExerciseSolution: vi.fn(),
	getLessonSessionExtract: vi.fn(),
	getWorkshopsForLesson: vi.fn(),
}))

vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/lib/lessons-query', () => ({
	getLesson: mocks.getLesson,
	getLessonVideoTranscript: mocks.getLessonVideoTranscript,
	getExerciseSolution: mocks.getExerciseSolution,
}))
vi.mock('@/lib/session-extract-query', () => ({
	getLessonSessionExtract: mocks.getLessonSessionExtract,
}))
vi.mock('@/lib/workshops-query', () => ({
	getCachedWorkshopNavigation: vi.fn(),
	getWorkshopsForLesson: mocks.getWorkshopsForLesson,
}))
vi.mock('@/lib/cohort-navigation-query', () => ({
	getCachedCohortNavigation: vi.fn(),
}))
vi.mock('./course-resources', () => ({ getCourseResource: vi.fn() }))

import type { ResourceNavigation } from '@/lib/content-navigation'

import { makeContentPort, workshopSections } from './content'

const BASE = 'https://aihero.test'

const node = (
	id: string,
	type: string,
	fields: Record<string, unknown>,
	resources: unknown[] = [],
) => ({
	resourceId: id,
	resourceOfId: 'parent',
	position: 0,
	metadata: null,
	resource: { id, type, fields, resources },
})

describe('workshopSections', () => {
	it('groups lessons by section, keeps top-level lessons, and drops drafts, videos and solutions', () => {
		const navigation = {
			id: 'w1',
			type: 'workshop',
			fields: { slug: 'week-one', title: 'Week One' },
			resources: [
				node('intro', 'lesson', {
					slug: 'intro',
					title: 'Intro',
					state: 'published',
				}),
				node('s1', 'section', { title: 'Section one' }, [
					node('l1', 'lesson', {
						slug: 'first',
						title: 'First',
						state: 'published',
					}),
					node('draft', 'lesson', {
						slug: 'draft',
						title: 'Draft',
						state: 'draft',
					}),
					node('v1', 'videoResource', { title: 'Video' }),
				]),
				node('s2', 'section', { title: 'Empty' }, [
					node('sol', 'solution', { slug: 'sol', title: 'Solution' }),
				]),
			],
		} as unknown as ResourceNavigation

		expect(workshopSections(navigation, BASE)).toEqual([
			{
				title: null,
				lessons: [
					{
						id: 'intro',
						slug: 'intro',
						title: 'Intro',
						type: 'lesson',
						url: `${BASE}/workshops/week-one/intro`,
					},
				],
			},
			{
				title: 'Section one',
				lessons: [
					{
						id: 'l1',
						slug: 'first',
						title: 'First',
						type: 'lesson',
						url: `${BASE}/workshops/week-one/first`,
					},
				],
			},
		])
	})
})

describe('lesson content', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getLesson.mockResolvedValue({
			id: 'lesson-1',
			type: 'lesson',
			fields: {
				slug: 'first',
				title: 'First',
				body: 'Exercise text',
				muxPlaybackId: 'playback-secret',
			},
		})
		mocks.getWorkshopsForLesson.mockResolvedValue([
			{ id: 'w1', fields: { slug: 'week-one', title: 'Week One' } },
		])
		mocks.getLessonVideoTranscript.mockResolvedValue('Transcript')
		mocks.getLessonSessionExtract.mockResolvedValue(null)
		mocks.getExerciseSolution.mockResolvedValue({
			solution: {
				fields: {
					title: 'Solution',
					body: 'Answer',
					muxAssetId: 'asset-secret',
				},
			},
		})
	})

	it('assembles the lesson with deep links and no Mux ids', async () => {
		const content = await makeContentPort({ baseUrl: BASE }).lesson({
			lesson: 'first',
		})
		expect(content).toEqual({
			lesson: { id: 'lesson-1', slug: 'first', title: 'First', type: 'lesson' },
			workshop: { id: 'w1', slug: 'week-one', title: 'Week One' },
			body: 'Exercise text',
			transcript: 'Transcript',
			solution: { title: 'Solution', body: 'Answer' },
			sessionExtract: null,
			links: {
				lesson: `${BASE}/workshops/week-one/first`,
				solution: `${BASE}/workshops/week-one/first/solution`,
				workshop: `${BASE}/workshops/week-one`,
			},
		})
		expect(JSON.stringify(content)).not.toMatch(/secret|mux/i)
	})

	it('prefers the workshop the caller named', async () => {
		mocks.getWorkshopsForLesson.mockResolvedValue([
			{ id: 'w1', fields: { slug: 'week-one', title: 'Week One' } },
			{ id: 'w2', fields: { slug: 'week-two', title: 'Week Two' } },
		])
		const content = await makeContentPort({ baseUrl: BASE }).lesson({
			lesson: 'first',
			workshop: 'week-two',
		})
		expect(content?.workshop.slug).toBe('week-two')
	})
})
