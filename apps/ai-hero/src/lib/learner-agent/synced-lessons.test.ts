import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getWorkshop: vi.fn(),
	getLesson: vi.fn(),
	getEntitlements: vi.fn(),
	getNavigation: vi.fn(),
	getCourse: vi.fn(),
	getPurchasedResources: vi.fn(),
	getSession: vi.fn(),
}))

vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/db', () => ({
	courseBuilderAdapter: { getPurchasesForUser: async () => [] },
	db: {
		query: {
			entitlementTypes: {
				findMany: async () => [
					{ id: 'cohort-type', name: 'cohort_content_access' },
					{ id: 'workshop-type', name: 'workshop_content_access' },
				],
			},
		},
	},
}))
vi.mock('@/server/auth', () => ({ getServerAuthSession: mocks.getSession }))
vi.mock('@/server/perf', () => ({
	measureIfSlow: ({ operation }: { operation: () => unknown }) => operation(),
}))
vi.mock('@/lib/entitlements-query', () => ({
	getAllUserEntitlements: mocks.getEntitlements,
}))
vi.mock('@/lib/library-query', () => ({
	getPurchasedResources: mocks.getPurchasedResources,
}))
vi.mock('@/lib/workshops-query', () => ({
	getWorkshop: mocks.getWorkshop,
	getCachedMinimalWorkshop: mocks.getWorkshop,
	getCachedWorkshopNavigation: mocks.getNavigation,
	getWorkshopsForLesson: async () => [module],
}))
vi.mock('@/lib/lessons-query', () => ({
	getLesson: mocks.getLesson,
	getCachedLesson: mocks.getLesson,
	getLessonVideoTranscript: async () => 'Synthetic transcript',
	getExerciseSolution: async () => ({
		solution: { fields: { title: 'Solution', body: 'Synthetic answer' } },
	}),
}))
vi.mock('@/lib/cohort-navigation-query', () => ({
	getCachedCohortNavigation: vi.fn(),
}))
vi.mock('@/lib/session-extract-query', () => ({
	getLessonSessionExtract: async () => null,
}))
vi.mock('@/lib/skills-query', () => ({ getSkillEntries: async () => [] }))
vi.mock('./session-extracts', () => ({
	getLessonSessionExtracts: async () => [],
	skillLinksFrom: () => [],
}))
vi.mock('./course-resources', () => ({ getCourseResource: mocks.getCourse }))

import { cohortAbilityFixture } from '@/ability/test-fixtures/cohort-content-scope'
import { getAbilityForResource } from '@/utils/get-current-ability-rules'
import { makeLearnerAgent } from '@ai-hero/learner-agent'
import { makeContentPort } from './content'
import { makeEntitlementsPort } from './entitlements'

const BASE = 'https://aihero.test'
const WORKSHOP_ID = 'sync_workshop_25f118091be7599ddc2d1878'
const SLUG = 'domain-language-d7e88814'
const learner = {
	userId: 'synthetic-viewer',
	tokenKind: 'learner-token',
} as const

// Structure-only regression fixture from Domain Language: published workshop,
// seven direct draft/unlisted lessons, no sections. Lesson text and titles
// are synthetic (the first title reuses the workshop's name).
const titles = Array.from({ length: 7 }, (_, index) =>
	index === 0 ? 'Domain Language' : `Synthetic topic ${index}`,
)
const base = cohortAbilityFixture({
	contentIds: [WORKSHOP_ID],
	startsAt: '2026-01-01T00:00:00.000Z',
})
const lessons = titles.map((title, index) => ({
	...base.lesson,
	id: `synthetic-sync-lesson-${index}`,
	fields: {
		...base.lesson.fields,
		title,
		slug: `lesson-${index}`,
		state: 'draft' as const,
		visibility: 'unlisted' as const,
	},
}))
const module = {
	...base.module,
	id: WORKSHOP_ID,
	fields: {
		...base.module.fields,
		title: 'Domain Language',
		slug: SLUG,
		state: 'published' as const,
	},
	resources: lessons.map((resource, position) => ({
		...base.module.resources![0]!,
		resourceId: resource.id,
		resourceOfId: WORKSHOP_ID,
		position,
		resource,
	})),
}

function agent() {
	const entitlements = makeEntitlementsPort({ baseUrl: BASE, country: 'US' })
	const content = makeContentPort({
		baseUrl: BASE,
		readableResourceIds: (id) => entitlements.readableResourceIds(learner, id),
	})
	return {
		entitlements,
		content,
		agent: makeLearnerAgent({
			learner,
			entitlements,
			content,
			progress: { completed: async () => [lessons[0]!.id] },
			search: { search: async () => [] },
			offers: { ownsOffer: async () => true, nextOffer: vi.fn() },
			audit: { read: vi.fn() },
			rateLimit: { consume: async () => ({ ok: true }) },
			site: {
				baseUrl: BASE,
				connectUrl: `${BASE}/agents/connect`,
				instructionsUrl: `${BASE}/agents`,
				mcpUrl: `${BASE}/mcp`,
			},
		}),
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.getWorkshop.mockResolvedValue(module)
	mocks.getNavigation.mockResolvedValue(module)
	mocks.getLesson.mockImplementation(
		async (id: string) =>
			lessons.find((lesson) => lesson.id === id || lesson.fields.slug === id) ??
			null,
	)
	mocks.getEntitlements.mockResolvedValue([
		{
			entitlementType: 'cohort-type',
			expiresAt: null,
			metadata: { contentIds: [WORKSHOP_ID] },
		},
	])
	mocks.getSession.mockResolvedValue({ session: { user: base.user } })
	mocks.getCourse.mockResolvedValue({
		id: WORKSHOP_ID,
		type: 'workshop',
		slug: SLUG,
		title: 'Domain Language',
		state: 'published',
		startsAt: module.fields.startsAt,
	})
	mocks.getPurchasedResources.mockResolvedValue([{ resourceId: WORKSHOP_ID }])
})

describe('course-synced lessons through the learner MCP capabilities', () => {
	it('changes Domain Language from 0 to 7 lessons and counts progress, using one workshop load', async () => {
		// The old outline predicate dropped every lesson in this fixture.
		expect(
			lessons.filter((lesson) => String(lesson.fields.state) === 'published'),
		).toHaveLength(0)
		const { agent: api } = agent()
		const response = await api.handleMcp(
			new Request(`${BASE}/mcp`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json, text/event-stream',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: { name: 'course_outline', arguments: { course: SLUG } },
				}),
			}),
		)
		expect(response.status).toBe(200)
		const result = await response.json()
		expect(result.result.isError).not.toBe(true)
		expect(result.result.structuredContent.progress).toEqual({
			completed: 1,
			total: 7,
		})
		expect(result.result.structuredContent.workshops).toMatchObject([
			{ sections: [{ lessons: titles.map((title) => ({ title })) }] },
		])
		expect(mocks.getWorkshop).toHaveBeenCalledTimes(1)
		expect(mocks.getEntitlements).toHaveBeenCalledTimes(1)
	})

	it('matches the actual page ability for every draft lesson, without a sync-ID exception', async () => {
		const ordinaryDraft = {
			...lessons[0]!,
			id: 'ordinary-draft',
			fields: { ...lessons[0]!.fields, slug: 'ordinary-draft' },
		}
		const withOrdinaryDraft = {
			...module,
			resources: [
				...module.resources,
				{
					...module.resources[0]!,
					resourceId: ordinaryDraft.id,
					resource: ordinaryDraft,
				},
			],
		}
		mocks.getWorkshop.mockResolvedValue(withOrdinaryDraft)
		mocks.getLesson.mockImplementation(
			async (id: string) =>
				[...lessons, ordinaryDraft].find((lesson) => lesson.id === id) ?? null,
		)
		const { entitlements } = agent()
		const ids = await entitlements.readableResourceIds(learner, WORKSHOP_ID)
		for (const lesson of [...lessons, ordinaryDraft]) {
			const page = await getAbilityForResource(lesson.id, WORKSHOP_ID)
			expect(page.canViewLesson).toBe(true)
			expect(ids.has(lesson.id)).toBe(page.canViewLesson)
			expect(
				await entitlements.lessonAccess(learner, {
					lesson: lesson.id,
					workshop: WORKSHOP_ID,
				}),
			).toEqual({ _tag: 'Readable' })
		}
	})

	it('reads a synced draft but keeps its solution hidden unless requested', async () => {
		const { agent: api } = agent()
		const result = await api.invoke('read_lesson', {
			lesson: lessons[0]!.id,
			workshop: WORKSHOP_ID,
		})
		expect(result).toMatchObject({ _tag: 'Success' })
		expect(JSON.stringify(result)).toContain('Protected synthetic body')
		expect(JSON.stringify(result)).not.toContain('Synthetic answer')
		const withSolution = await api.invoke('read_lesson', {
			lesson: lessons[0]!.id,
			workshop: WORKSHOP_ID,
			includeSolution: true,
		})
		expect(JSON.stringify(withSolution)).toContain('Synthetic answer')
	})

	it('refuses the outline and lesson for a non-entitled learner and returns no owned search hits', async () => {
		mocks.getEntitlements.mockResolvedValue([])
		mocks.getPurchasedResources.mockResolvedValue([])
		const { agent: api, entitlements } = agent()
		expect(
			await entitlements.readableResourceIds(learner, WORKSHOP_ID),
		).toEqual(new Set())
		expect(await api.invoke('course_outline', { course: SLUG })).toMatchObject({
			_tag: 'Failure',
			error: { _tag: 'NotEntitled' },
		})
		expect(
			await api.invoke('read_lesson', {
				lesson: lessons[0]!.id,
				workshop: WORKSHOP_ID,
			}),
		).toMatchObject({ _tag: 'Failure', error: { _tag: 'NotEntitled' } })
		expect(
			await api.invoke('search_course', { query: 'Domain' }),
		).toMatchObject({ _tag: 'Success', output: { hits: [] } })
	})

	it('hides lessons under an unpublished workshop from outline, read and search', async () => {
		mocks.getWorkshop.mockResolvedValue({
			...module,
			fields: { ...module.fields, state: 'draft' },
		})
		const { agent: api } = agent()
		expect(await api.invoke('course_outline', { course: SLUG })).toMatchObject({
			_tag: 'Success',
			output: {
				progress: { total: 0 },
				workshops: [{ access: 'not_yet_open', sections: [] }],
			},
		})
		expect(
			await api.invoke('read_lesson', {
				lesson: lessons[0]!.id,
				workshop: WORKSHOP_ID,
			}),
		).toMatchObject({ _tag: 'Failure', error: { _tag: 'NotYetOpen' } })
		expect(
			await api.invoke('search_course', { query: 'Domain' }),
		).toMatchObject({ _tag: 'Success', output: { hits: [] } })
	})

	it('finds synced lessons through owned search without widening public Typesense search', async () => {
		const { agent: api } = agent()
		expect(
			await api.invoke('search_course', { query: 'Domain' }),
		).toMatchObject({
			_tag: 'Success',
			output: {
				hits: [
					{ id: lessons[0]!.id, title: 'Domain Language', readable: true },
				],
			},
		})
	})
})
