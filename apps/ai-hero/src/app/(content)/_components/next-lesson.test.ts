import { describe, expect, it } from 'vitest'

import type { ResourceNavigation } from '@/lib/content-navigation'
import type { ContentResource } from '@coursebuilder/core/schemas'

import {
	getArrivalPosterUrl,
	getLessonThumbnailUrl,
	getNextLesson,
} from './next-lesson'

const now = new Date()

function resource(
	id: string,
	type: string,
	resources: unknown[] | null = null,
): ContentResource {
	return {
		id,
		type,
		createdById: 'user-1',
		createdAt: now,
		updatedAt: now,
		deletedAt: null,
		organizationId: null,
		createdByOrganizationMembershipId: null,
		fields: { slug: id, title: `Title ${id}` },
		resources,
	} as ContentResource
}

function wrap(child: ContentResource, parentId: string) {
	return {
		resourceId: child.id,
		resourceOfId: parentId,
		position: 0,
		metadata: {},
		createdAt: now,
		updatedAt: now,
		deletedAt: null,
		resource: child,
	}
}

const video = resource('video-2', 'videoResource')
const solution = resource('solution-1', 'solution')
const lesson1 = resource('lesson-1', 'lesson', [wrap(solution, 'lesson-1')])
const lesson2 = resource('lesson-2', 'lesson', [wrap(video, 'lesson-2')])
const section = resource('section-1', 'section', [
	wrap(lesson1, 'section-1'),
	wrap(lesson2, 'section-1'),
])
const navigation = {
	...resource('workshop-1', 'workshop', [wrap(section, 'workshop-1')]),
	fields: { slug: 'the-workshop', title: 'The Workshop' },
} as ResourceNavigation

describe('getNextLesson', () => {
	it('describes the next lesson with its place and thumbnail', () => {
		expect(
			getNextLesson({ navigation, next: lesson2, moduleType: 'workshop' }),
		).toMatchObject({
			title: 'Title lesson-2',
			href: '/workshops/the-workshop/lesson-2',
			isSolution: false,
			number: 2,
			total: 2,
			thumbnailUrl: '/api/thumbnails?videoResourceId=video-2',
		})
	})

	it("titles and links a solution after its lesson, without a count", () => {
		expect(
			getNextLesson({ navigation, next: solution, moduleType: 'workshop' }),
		).toMatchObject({
			title: 'Title lesson-1',
			href: '/workshops/the-workshop/lesson-1/solution',
			isSolution: true,
			number: null,
			thumbnailUrl: null,
		})
	})

	it('has nothing without a next resource or a workshop slug', () => {
		expect(
			getNextLesson({ navigation, next: null, moduleType: 'workshop' }),
		).toBeNull()
		expect(
			getNextLesson({ navigation: null, next: lesson2, moduleType: 'workshop' }),
		).toBeNull()
	})
})

describe('getLessonThumbnailUrl', () => {
	it('asks for a given frame, or the video’s own thumbnail time', () => {
		expect(getLessonThumbnailUrl(lesson2, 0)).toBe(
			'/api/thumbnails?videoResourceId=video-2&time=0',
		)
		expect(getLessonThumbnailUrl(lesson1)).toBeNull()
	})
})

describe('getArrivalPosterUrl', () => {
	it('is frame 0 at player width, the URL the previous lesson preloads', () => {
		expect(getArrivalPosterUrl(lesson2)).toBe(
			'/api/thumbnails?videoResourceId=video-2&time=0&width=720',
		)
		expect(getArrivalPosterUrl(lesson1)).toBeNull()
	})
})
