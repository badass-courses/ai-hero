import { beforeEach, describe, expect, it, vi } from 'vitest'

import { cohortAbilityFixture } from '@/ability/test-fixtures/cohort-content-scope'

const mocks = vi.hoisted(() => ({
	getPurchasesForUser: vi.fn(),
	entitlementTypes: vi.fn(),
	getAllUserEntitlements: vi.fn(),
	getLesson: vi.fn(),
	getWorkshop: vi.fn(),
	getWorkshopsForLesson: vi.fn(),
	getPurchasedResources: vi.fn(),
	getCachedCohortNavigation: vi.fn(),
	getCourseResource: vi.fn(),
	rulesUser: vi.fn(),
}))

vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }))
vi.mock('@/db', () => ({
	courseBuilderAdapter: { getPurchasesForUser: mocks.getPurchasesForUser },
	db: { query: { entitlementTypes: { findMany: mocks.entitlementTypes } } },
}))
vi.mock('@/lib/entitlements-query', () => ({
	getAllUserEntitlements: mocks.getAllUserEntitlements,
}))
vi.mock('@/lib/lessons-query', () => ({ getLesson: mocks.getLesson }))
vi.mock('@/lib/workshops-query', () => ({
	getWorkshop: mocks.getWorkshop,
	getWorkshopsForLesson: mocks.getWorkshopsForLesson,
}))
vi.mock('@/lib/library-query', () => ({
	getPurchasedResources: mocks.getPurchasedResources,
}))
vi.mock('@/lib/cohort-navigation-query', () => ({
	getCachedCohortNavigation: mocks.getCachedCohortNavigation,
}))
vi.mock('./course-resources', () => ({
	getCourseResource: mocks.getCourseResource,
}))
vi.mock('@/ability', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/ability')>()
	return {
		...actual,
		defineRulesForPurchases: (
			input: Parameters<typeof actual.defineRulesForPurchases>[0],
		) => {
			mocks.rulesUser(input.user)
			return actual.defineRulesForPurchases(input)
		},
	}
})

import { makeEntitlementsPort } from './entitlements'

const learner = {
	userId: 'synthetic-viewer',
	tokenKind: 'learner-token',
} as const
// Built per test: a port memoizes one request's learner inputs.
let port: ReturnType<typeof makeEntitlementsPort>

const PAST = '2026-01-01T00:00:00.000Z'
const FUTURE = '2099-01-01T00:00:00.000Z'

/** The fixture's workshop, released (published) and opening at `startsAt`. */
function arrange({
	startsAt = PAST,
	state = 'published',
	entitlements = [
		{
			entitlementType: 'cohort-type',
			expiresAt: null,
			metadata: { contentIds: ['requested-workshop'] },
		},
	],
}: {
	startsAt?: string | null
	state?: string
	entitlements?: Array<{
		entitlementType: string
		expiresAt: Date | null
		metadata: Record<string, unknown>
	}>
} = {}) {
	const fixture = cohortAbilityFixture({
		contentIds: ['requested-workshop'],
		startsAt,
	})
	const module = {
		...fixture.module,
		fields: { ...fixture.module.fields, state },
	}
	mocks.getWorkshop.mockResolvedValue(module)
	mocks.getLesson.mockResolvedValue(fixture.lesson)
	mocks.getWorkshopsForLesson.mockResolvedValue([{ id: module.id }])
	mocks.getAllUserEntitlements.mockResolvedValue(entitlements)
	return { module, lesson: fixture.lesson }
}

beforeEach(() => {
	vi.clearAllMocks()
	port = makeEntitlementsPort({ baseUrl: 'https://aihero.test', country: 'US' })
	mocks.getPurchasesForUser.mockResolvedValue([])
	mocks.entitlementTypes.mockResolvedValue([
		{ id: 'cohort-type', name: 'cohort_content_access' },
		{ id: 'workshop-type', name: 'workshop_content_access' },
	])
})

describe('learner entitlements, as the lesson page decides them', () => {
	it('opens an owned, released workshop and its lessons', async () => {
		arrange()
		expect(await port.workshopAccess(learner, 'requested-workshop')).toEqual({
			_tag: 'Open',
		})
		expect(await port.lessonAccess(learner, { lesson: 'paid-lesson' })).toEqual(
			{ _tag: 'Readable' },
		)
	})

	it('holds an owned workshop before its open date: title and date only', async () => {
		arrange({ startsAt: FUTURE })
		expect(await port.workshopAccess(learner, 'requested-workshop')).toEqual({
			_tag: 'NotYetOpen',
			opensAt: FUTURE,
		})
		expect(await port.lessonAccess(learner, { lesson: 'paid-lesson' })).toEqual(
			{
				_tag: 'NotYetOpen',
				workshopTitle: 'Requested workshop',
				opensAt: FUTURE,
			},
		)
	})

	it('holds an owned workshop that is not published yet', async () => {
		arrange({ state: 'draft' })
		expect(
			await port.workshopAccess(learner, 'requested-workshop'),
		).toMatchObject({ _tag: 'NotYetOpen' })
		expect(
			await port.lessonAccess(learner, { lesson: 'paid-lesson' }),
		).toMatchObject({ _tag: 'NotYetOpen' })
	})

	it('lets early access through before the date, as the browser does', async () => {
		arrange({
			startsAt: FUTURE,
			entitlements: [
				{
					entitlementType: 'cohort-type',
					expiresAt: null,
					metadata: { contentIds: ['requested-workshop'], earlyAccess: true },
				},
			],
		})
		expect(await port.workshopAccess(learner, 'requested-workshop')).toEqual({
			_tag: 'Open',
		})
	})

	it('refuses a refunded or transferred learner, whose entitlements are gone', async () => {
		arrange({ entitlements: [] })
		expect(await port.workshopAccess(learner, 'requested-workshop')).toEqual({
			_tag: 'NotEntitled',
		})
		expect(await port.lessonAccess(learner, { lesson: 'paid-lesson' })).toEqual(
			{
				_tag: 'NotEntitled',
				workshopUrl: 'https://aihero.test/workshops/requested-workshop',
			},
		)
	})

	it('refuses a learner entitled to a different workshop', async () => {
		arrange({
			entitlements: [
				{
					entitlementType: 'cohort-type',
					expiresAt: null,
					metadata: { contentIds: ['another-workshop'] },
				},
			],
		})
		expect(
			await port.lessonAccess(learner, { lesson: 'paid-lesson' }),
		).toMatchObject({ _tag: 'NotEntitled' })
	})

	it('never passes roles into the rules, so no token reads as admin', async () => {
		arrange({ entitlements: [] })
		await port.lessonAccess(learner, { lesson: 'paid-lesson' })
		expect(mocks.rulesUser).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'synthetic-viewer', roles: [] }),
		)
	})

	it('reports a lesson outside the named workshop as not found', async () => {
		arrange()
		mocks.getWorkshop.mockResolvedValue({
			...cohortAbilityFixture().module,
			id: 'other-workshop',
			resources: [],
		})
		expect(
			await port.lessonAccess(learner, {
				lesson: 'paid-lesson',
				workshop: 'other-workshop',
			}),
		).toEqual({
			_tag: 'NotFound',
		})
	})
})

describe('the courses a learner owns', () => {
	const workshop = (id: string, startsAt: string) => {
		const { module } = cohortAbilityFixture({ startsAt })
		return {
			...module,
			id,
			fields: {
				...module.fields,
				slug: id,
				title: id,
				state: 'published',
				startsAt,
			},
		}
	}
	const modules: Record<string, ReturnType<typeof workshop>> = {
		w1: workshop('w1', PAST),
		w2: workshop('w2', FUTURE),
		'w-bundle': workshop('w-bundle', PAST),
	}
	const courseResources: Record<string, unknown> = {
		'cohort-1': {
			id: 'cohort-1',
			type: 'cohort',
			slug: 'ai-coding',
			title: 'AI Coding',
			state: 'published',
			startsAt: null,
		},
		w1: {
			id: 'w1',
			type: 'workshop',
			slug: 'w1',
			title: 'w1',
			state: 'published',
			startsAt: PAST,
		},
		'w-bundle': {
			id: 'w-bundle',
			type: 'workshop',
			slug: 'w-bundle',
			title: 'w-bundle',
			state: 'published',
			startsAt: PAST,
		},
	}
	const purchase = (resourceId: string) => ({
		key: resourceId,
		resourceId,
		resourceType: 'cohort',
		resourceSlug: resourceId,
		title: resourceId,
		purchasedAt: null,
	})
	const cohortEntitlement = (metadata: Record<string, unknown> = {}) => ({
		entitlementType: 'cohort-type',
		expiresAt: null,
		metadata: { contentIds: ['w1', 'w2'], ...metadata },
	})

	beforeEach(() => {
		mocks.getWorkshop.mockImplementation(async (id: string) => modules[id])
		mocks.getCourseResource.mockImplementation(
			async (id: string) => courseResources[id] ?? null,
		)
		mocks.getPurchasedResources.mockResolvedValue([])
		mocks.getAllUserEntitlements.mockResolvedValue([])
		mocks.getCachedCohortNavigation.mockResolvedValue({
			id: 'cohort-1',
			slug: 'ai-coding',
			title: 'AI Coding',
			workshops: ['w1', 'w2'].map((id, position) => ({
				id,
				slug: id,
				title: id,
				position,
				state: 'published',
				startsAt: modules[id]!.fields.startsAt,
				timezone: 'UTC',
				firstLesson: null,
			})),
		})
	})

	it('lists an owned cohort with each workshop’s open state and the next open date', async () => {
		mocks.getPurchasedResources.mockResolvedValue([purchase('cohort-1')])
		mocks.getAllUserEntitlements.mockResolvedValue([cohortEntitlement()])

		const [course, ...rest] = await port.ownedCourses(learner)
		expect(rest).toEqual([])
		expect(course).toMatchObject({
			slug: 'ai-coding',
			type: 'cohort',
			url: 'https://aihero.test/cohorts/ai-coding',
			nextOpensAt: FUTURE,
		})
		expect(course?.workshops.map((w) => [w.slug, w.isOpen])).toEqual([
			['w1', true],
			['w2', false],
		])
	})

	it('agrees with workshopAccess under early access: open now, nothing to wait for', async () => {
		mocks.getPurchasedResources.mockResolvedValue([purchase('cohort-1')])
		mocks.getAllUserEntitlements.mockResolvedValue([
			cohortEntitlement({ earlyAccess: true }),
		])

		expect(await port.workshopAccess(learner, 'w2')).toEqual({ _tag: 'Open' })
		const [course] = await port.ownedCourses(learner)
		expect(course?.workshops.map((w) => [w.slug, w.isOpen])).toEqual([
			['w1', true],
			['w2', true],
		])
		expect(course?.nextOpensAt).toBeNull()
	})

	it('lists a workshop granted by an entitlement, with no purchase of its own', async () => {
		mocks.getAllUserEntitlements.mockResolvedValue([
			{
				entitlementType: 'workshop-type',
				expiresAt: null,
				metadata: { contentIds: ['w-bundle'] },
			},
		])

		const courses = await port.ownedCourses(learner)
		expect(courses.map((course) => [course.slug, course.type])).toEqual([
			['w-bundle', 'workshop'],
		])
		expect(courses[0]?.workshops[0]?.isOpen).toBe(true)
	})

	it('does not list a cohort’s workshops again on their own', async () => {
		mocks.getPurchasedResources.mockResolvedValue([
			purchase('cohort-1'),
			purchase('w1'),
		])
		mocks.getAllUserEntitlements.mockResolvedValue([cohortEntitlement()])

		const courses = await port.ownedCourses(learner)
		expect(courses.map((course) => course.slug)).toEqual(['ai-coding'])
	})

	it('drops a course with no workshop the learner can reach, as course_outline refuses it', async () => {
		mocks.getPurchasedResources.mockResolvedValue([purchase('w-bundle')])

		expect(await port.ownedCourses(learner)).toEqual([])
	})

	it('loads the learner’s purchases and entitlements once per request', async () => {
		mocks.getPurchasedResources.mockResolvedValue([purchase('cohort-1')])
		mocks.getAllUserEntitlements.mockResolvedValue([cohortEntitlement()])

		await port.ownedCourses(learner)
		await port.workshopAccess(learner, 'w1')
		expect(mocks.getAllUserEntitlements).toHaveBeenCalledTimes(1)
		expect(mocks.getPurchasesForUser).toHaveBeenCalledTimes(1)
	})
})
