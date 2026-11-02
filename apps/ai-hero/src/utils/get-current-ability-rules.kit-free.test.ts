import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	cookies: new Map<string, string>(),
	getWorkshop: vi.fn(),
	getLesson: vi.fn(),
	getSession: vi.fn(),
	getSubscriber: vi.fn(),
	getSubscriberByEmail: vi.fn(),
	getSubscriberFromCookie: vi.fn(),
}))
vi.mock('@/db', () => ({
	db: {
		query: {
			organizationMemberships: { findMany: async () => [] },
			entitlements: { findMany: async () => [] },
			entitlementTypes: {
				findMany: async () => [
					{ id: 'cohort-type', name: 'cohort_content_access' },
					{ id: 'workshop-type', name: 'workshop_content_access' },
				],
			},
		},
	},
	courseBuilderAdapter: { getPurchasesForUser: async () => [] },
}))
vi.mock('react', async (original) => ({
	...(await original<typeof import('react')>()),
	cache: (fn: unknown) => fn,
}))
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }))
vi.mock('next/headers', () => ({
	headers: async () => new Headers(),
	cookies: async () => ({
		get: (name: string) =>
			mocks.cookies.has(name)
				? { name, value: mocks.cookies.get(name)! }
				: undefined,
	}),
}))
vi.mock('@/lib/convertkit', () => ({
	getSubscriberFromCookie: mocks.getSubscriberFromCookie,
}))
vi.mock('@/coursebuilder/email-list-provider', () => ({
	emailListProvider: {
		getSubscriber: mocks.getSubscriber,
		getSubscriberByEmail: mocks.getSubscriberByEmail,
	},
}))
vi.mock('@/lib/lessons-query', () => ({
	getCachedLesson: mocks.getLesson,
	getLesson: mocks.getLesson,
}))
vi.mock('@/lib/workshops-query', () => ({
	getWorkshop: mocks.getWorkshop,
	getCachedMinimalWorkshop: mocks.getWorkshop,
}))
vi.mock('@/server/auth', () => ({ getServerAuthSession: mocks.getSession }))
vi.mock('@/server/perf', () => ({
	measureIfSlow: ({ operation }: { operation: () => Promise<unknown> }) =>
		operation(),
}))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/utils/get-resource-section', () => ({
	getResourceSection: async () => null,
}))

import { defineRulesForPurchases } from '@/ability'
import { cohortAbilityFixture } from '@/ability/test-fixtures/cohort-content-scope'
import { getCurrentAbilityRules } from './get-current-ability-rules'

// A full Kit record, the shape getSubscriberFromCookie used to return here.
const kitSubscriber = {
	id: 1234567,
	first_name: 'Synthetic',
	email_address: 'viewer@example.test',
	state: 'active',
	created_at: '2026-01-01T00:00:00Z',
	fields: { skills_course_started_on: '2026-10-01' },
}

const viewers = {
	anonymous: () => {
		const fixture = cohortAbilityFixture()
		return { ...fixture, input: { ...fixture.input, user: undefined } }
	},
	entitled: () => cohortAbilityFixture({ contentIds: ['requested-workshop'] }),
	unentitled: () => cohortAbilityFixture({ contentIds: [] }),
	freeLesson: () => cohortAbilityFixture({ free: true }),
	admin: () => cohortAbilityFixture({ roles: ['admin'] }),
}

describe('ability rules without the Kit subscriber', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.cookies.clear()
		mocks.getSubscriberFromCookie.mockResolvedValue(kitSubscriber)
		mocks.getSubscriber.mockResolvedValue(kitSubscriber)
	})

	it.each(Object.entries(viewers))(
		'defineRulesForPurchases ignores a subscriber input (%s)',
		(_name, viewer) => {
			const { input } = viewer()
			expect(
				defineRulesForPurchases({ ...input, subscriber: kitSubscriber }),
			).toEqual(defineRulesForPurchases(input))
		},
	)

	it.each(Object.entries(viewers))(
		'getCurrentAbilityRules is identical with and without Kit cookies, with no Kit call (%s)',
		async (_name, viewer) => {
			const fixture = viewer()
			mocks.getSession.mockResolvedValue({
				session: fixture.input.user ? { user: fixture.input.user } : null,
			})
			mocks.getWorkshop.mockResolvedValue(fixture.module)
			mocks.getLesson.mockResolvedValue(fixture.lesson)
			const args = { lessonId: 'paid-lesson', moduleId: 'requested-workshop' }

			const withoutCookie = await getCurrentAbilityRules(args)

			mocks.cookies.set('ck_subscriber_id', String(kitSubscriber.id))
			mocks.cookies.set('ck_subscriber', JSON.stringify(kitSubscriber))
			const withCookie = await getCurrentAbilityRules(args)

			expect(withCookie).toEqual(withoutCookie)
			expect(withoutCookie.length).toBeGreaterThan(0)
			expect(mocks.getSubscriberFromCookie).not.toHaveBeenCalled()
			expect(mocks.getSubscriber).not.toHaveBeenCalled()
			expect(mocks.getSubscriberByEmail).not.toHaveBeenCalled()
		},
	)
})
