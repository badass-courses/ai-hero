import { afterEach, describe, expect, it, vi } from 'vitest'

import { GET as getPostMarkdown } from '../[slug]/route'
import { GET as getCohortMarkdown } from '../cohorts/[slug]/route'
import { GET as getEventMarkdown } from '../events/[slug]/route'
import { GET as getProductMarkdown } from '../products/[slug]/route'
import { GET as getTutorialLessonMarkdown } from '../tutorials/[module]/[lesson]/route'
import { GET as getWorkshopLessonMarkdown } from '../workshops/[module]/[lesson]/route'
import { GET as getWorkshopMarkdown } from '../workshops/[module]/route'

const {
	getCachedPostOrListMock,
	getTutorialMock,
	getWorkshopMock,
	getLessonMock,
	getProductMock,
	getCachedCohortMock,
	getEventMock,
} = vi.hoisted(() => ({
	getCachedPostOrListMock: vi.fn(),
	getTutorialMock: vi.fn(),
	getWorkshopMock: vi.fn(),
	getLessonMock: vi.fn(),
	getProductMock: vi.fn(),
	getCachedCohortMock: vi.fn(),
	getEventMock: vi.fn(),
}))

vi.mock('@/lib/posts-query', () => ({
	getCachedPostOrList: getCachedPostOrListMock,
}))

vi.mock('@/lib/tutorials-query', () => ({
	getTutorial: getTutorialMock,
}))

vi.mock('@/lib/workshops-query', () => ({
	getWorkshop: getWorkshopMock,
}))

vi.mock('@/lib/lessons-query', () => ({
	getLesson: getLessonMock,
}))

vi.mock('@/lib/products-query', () => ({
	getProduct: getProductMock,
}))

vi.mock('@/lib/cohorts-query', () => ({
	getCachedCohort: getCachedCohortMock,
}))

vi.mock('@/lib/events-query', () => ({
	getEvent: getEventMock,
}))

const publicPost = {
	id: 'post_1',
	type: 'post',
	fields: {
		title: 'Public Post',
		slug: 'public-post',
		description: 'Public post description',
		body: '## Public post body',
		state: 'published',
		visibility: 'public',
	},
	tags: [
		{
			tag: {
				fields: {
					name: 'Agents',
					slug: 'agents',
				},
			},
		},
	],
	updatedAt: new Date('2025-01-01T00:00:00.000Z'),
}

const publicLesson = {
	id: 'lesson_1',
	type: 'lesson',
	fields: {
		title: 'Public Lesson',
		slug: 'public-lesson',
		description: 'Public lesson description',
		body: '## Public lesson body',
		state: 'published',
		visibility: 'public',
	},
	tags: null,
	updatedAt: new Date('2025-01-02T00:00:00.000Z'),
}

const publicTutorial = {
	id: 'tutorial_1',
	type: 'tutorial',
	fields: {
		title: 'Public Tutorial',
		slug: 'public-tutorial',
		description: 'Public tutorial description',
		state: 'published',
		visibility: 'public',
	},
	resources: [
		{
			resourceId: 'section_1',
			resourceOfId: 'tutorial_1',
			position: 0,
			resource: {
				id: 'section_1',
				type: 'section',
				fields: {
					title: 'Section',
					slug: 'section',
				},
				resources: [
					{
						resourceId: publicLesson.id,
						resourceOfId: 'section_1',
						position: 0,
						resource: {
							id: publicLesson.id,
							type: publicLesson.type,
							fields: {
								title: publicLesson.fields.title,
								slug: publicLesson.fields.slug,
							},
						},
					},
				],
			},
		},
	],
}

const publicWorkshop = {
	id: 'workshop_1',
	type: 'workshop',
	fields: {
		title: 'Public Workshop',
		slug: 'public-workshop',
		description: 'Public workshop description',
		body: '## Public workshop body',
		state: 'published',
		visibility: 'public',
	},
	tags: null,
	resources: [
		{
			resourceId: publicLesson.id,
			resourceOfId: 'workshop_1',
			position: 0,
			metadata: {
				tier: 'free',
			},
			resource: {
				id: publicLesson.id,
				type: publicLesson.type,
				fields: {
					title: publicLesson.fields.title,
					slug: publicLesson.fields.slug,
				},
				resources: [],
			},
		},
	],
	updatedAt: new Date('2025-01-03T00:00:00.000Z'),
}

const publicProduct = {
	id: 'product_1',
	name: 'Public Product',
	type: 'self-paced',
	fields: {
		slug: 'public-product',
		description: 'Public product description',
		body: '## Public product body',
		state: 'published',
		visibility: 'public',
	},
	createdAt: new Date('2025-01-04T00:00:00.000Z'),
}

const publicCohort = {
	id: 'cohort_1',
	type: 'cohort',
	fields: {
		title: 'Public Cohort',
		slug: 'public-cohort',
		description: 'Public cohort description',
		body: '## Public cohort body',
		state: 'published',
		visibility: 'public',
	},
	updatedAt: new Date('2025-01-05T00:00:00.000Z'),
}

const publicEvent = {
	id: 'event_1',
	type: 'event',
	fields: {
		title: 'Public Event',
		slug: 'public-event',
		description: 'Public event description',
		body: '## Public event body',
		state: 'published',
		visibility: 'public',
	},
	updatedAt: new Date('2025-01-06T00:00:00.000Z'),
}

afterEach(() => {
	vi.clearAllMocks()
})

describe('markdown route handlers', () => {
	it('serves published public posts as markdown', async () => {
		getCachedPostOrListMock.mockResolvedValue(publicPost)

		const response = await getPostMarkdown(
			new Request('http://localhost') as any,
			{
				params: Promise.resolve({ slug: publicPost.fields.slug }),
			},
		)

		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe(
			'text/markdown; charset=utf-8',
		)
		await expect(response.text()).resolves.toContain('title: "Public Post"')
	})

	it('hides unpublished posts from markdown', async () => {
		getCachedPostOrListMock.mockResolvedValue({
			...publicPost,
			fields: {
				...publicPost.fields,
				state: 'draft',
			},
		})

		const response = await getPostMarkdown(
			new Request('http://localhost') as any,
			{
				params: Promise.resolve({ slug: publicPost.fields.slug }),
			},
		)

		expect(response.status).toBe(404)
	})

	it('omits invalid markdown updatedAt values instead of crashing', async () => {
		getCachedPostOrListMock.mockResolvedValue({
			...publicPost,
			updatedAt: 'not-a-date',
		})

		const response = await getPostMarkdown(
			new Request('http://localhost/public-post?nxtPslug=public-post', {
				headers: { accept: 'text/plain' },
			}) as any,
			{
				params: Promise.resolve({ slug: publicPost.fields.slug }),
			},
		)

		expect(response.status).toBe(200)
		await expect(response.text()).resolves.not.toContain('updatedAt')
	})

	it('serves published public tutorial lessons as markdown', async () => {
		getTutorialMock.mockResolvedValue(publicTutorial)
		getLessonMock.mockResolvedValue(publicLesson)

		const response = await getTutorialLessonMarkdown(
			new Request('http://localhost') as any,
			{
				params: Promise.resolve({
					module: publicTutorial.fields.slug,
					lesson: publicLesson.fields.slug,
				}),
			},
		)

		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe(
			'text/markdown; charset=utf-8',
		)
		await expect(response.text()).resolves.toContain('title: "Public Lesson"')
	})

	it('hides non-public tutorial lessons from markdown', async () => {
		getTutorialMock.mockResolvedValue(publicTutorial)
		getLessonMock.mockResolvedValue({
			...publicLesson,
			fields: {
				...publicLesson.fields,
				visibility: 'private',
			},
		})

		const response = await getTutorialLessonMarkdown(
			new Request('http://localhost') as any,
			{
				params: Promise.resolve({
					module: publicTutorial.fields.slug,
					lesson: publicLesson.fields.slug,
				}),
			},
		)

		expect(response.status).toBe(404)
	})

	it('serves free published public workshop lessons as markdown', async () => {
		getWorkshopMock.mockResolvedValue(publicWorkshop)
		getLessonMock.mockResolvedValue(publicLesson)

		const response = await getWorkshopLessonMarkdown(
			new Request('http://localhost') as any,
			{
				params: Promise.resolve({
					module: publicWorkshop.fields.slug,
					lesson: publicLesson.fields.slug,
				}),
			},
		)

		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe(
			'text/markdown; charset=utf-8',
		)
		await expect(response.text()).resolves.toContain('title: "Public Lesson"')
	})

	it('hides paid workshop lessons from markdown', async () => {
		getWorkshopMock.mockResolvedValue({
			...publicWorkshop,
			resources: [
				{
					...publicWorkshop.resources[0],
					metadata: {
						tier: 'pro',
					},
				},
			],
		})

		const response = await getWorkshopLessonMarkdown(
			new Request('http://localhost') as any,
			{
				params: Promise.resolve({
					module: publicWorkshop.fields.slug,
					lesson: publicLesson.fields.slug,
				}),
			},
		)

		expect(response.status).toBe(404)
		expect(getLessonMock).not.toHaveBeenCalled()
	})

	it('serves published public products as markdown', async () => {
		getProductMock.mockResolvedValue(publicProduct)

		const response = await getProductMarkdown(
			new Request('http://localhost') as any,
			{
				params: Promise.resolve({ slug: publicProduct.fields.slug }),
			},
		)

		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe(
			'text/markdown; charset=utf-8',
		)
		await expect(response.text()).resolves.toContain('title: "Public Product"')
	})

	it('hides non-public products from markdown', async () => {
		getProductMock.mockResolvedValue({
			...publicProduct,
			fields: {
				...publicProduct.fields,
				visibility: 'private',
			},
		})

		const response = await getProductMarkdown(
			new Request('http://localhost') as any,
			{
				params: Promise.resolve({ slug: publicProduct.fields.slug }),
			},
		)

		expect(response.status).toBe(404)
	})

	it('serves published public cohorts as markdown', async () => {
		getCachedCohortMock.mockResolvedValue(publicCohort)

		const response = await getCohortMarkdown(
			new Request('http://localhost') as any,
			{
				params: Promise.resolve({ slug: publicCohort.fields.slug }),
			},
		)

		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe(
			'text/markdown; charset=utf-8',
		)
		await expect(response.text()).resolves.toContain('title: "Public Cohort"')
	})

	it('hides unpublished cohorts from markdown', async () => {
		getCachedCohortMock.mockResolvedValue({
			...publicCohort,
			fields: {
				...publicCohort.fields,
				state: 'draft',
			},
		})

		const response = await getCohortMarkdown(
			new Request('http://localhost') as any,
			{
				params: Promise.resolve({ slug: publicCohort.fields.slug }),
			},
		)

		expect(response.status).toBe(404)
	})

	it('serves published public events as markdown', async () => {
		getEventMock.mockResolvedValue(publicEvent)

		const response = await getEventMarkdown(
			new Request('http://localhost') as any,
			{
				params: Promise.resolve({ slug: publicEvent.fields.slug }),
			},
		)

		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe(
			'text/markdown; charset=utf-8',
		)
		await expect(response.text()).resolves.toContain('title: "Public Event"')
	})

	it('hides non-public events from markdown', async () => {
		getEventMock.mockResolvedValue({
			...publicEvent,
			fields: {
				...publicEvent.fields,
				visibility: 'private',
			},
		})

		const response = await getEventMarkdown(
			new Request('http://localhost') as any,
			{
				params: Promise.resolve({ slug: publicEvent.fields.slug }),
			},
		)

		expect(response.status).toBe(404)
	})

	it('serves published public workshop landing pages as markdown', async () => {
		getWorkshopMock.mockResolvedValue(publicWorkshop)

		const response = await getWorkshopMarkdown(
			new Request('http://localhost') as any,
			{
				params: Promise.resolve({ module: publicWorkshop.fields.slug }),
			},
		)

		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe(
			'text/markdown; charset=utf-8',
		)
		await expect(response.text()).resolves.toContain('title: "Public Workshop"')
	})

	it('hides unpublished workshop landing pages from markdown', async () => {
		getWorkshopMock.mockResolvedValue({
			...publicWorkshop,
			fields: {
				...publicWorkshop.fields,
				state: 'draft',
			},
		})

		const response = await getWorkshopMarkdown(
			new Request('http://localhost') as any,
			{
				params: Promise.resolve({ module: publicWorkshop.fields.slug }),
			},
		)

		expect(response.status).toBe(404)
	})
})
