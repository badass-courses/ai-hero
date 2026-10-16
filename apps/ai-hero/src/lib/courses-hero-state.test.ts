import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	checkCohortAccess: vi.fn(),
	getCachedCohort: vi.fn(),
	getServerAuthSession: vi.fn(),
	getCurrentOrganizationId: vi.fn(),
	memberships: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/db', () => ({
	db: { query: { organizationMemberships: { findMany: mocks.memberships } } },
}))
vi.mock('@/db/schema', () => ({
	organizationMemberships: { userId: 'userId' },
}))
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }))
vi.mock('@/lib/cohorts-query', () => ({
	checkCohortAccess: mocks.checkCohortAccess,
	getCachedCohort: mocks.getCachedCohort,
}))
vi.mock('@/lib/next-offer', () => ({ getNextOfferSafe: async () => null }))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))
vi.mock('@/server/logger', () => ({ log: { error: vi.fn() } }))
vi.mock('@/server/organization-context', () => ({
	getCurrentOrganizationId: mocks.getCurrentOrganizationId,
}))

import { getCoursesHeroState } from './courses-hero-state'

const flagship = {
	id: 'c1',
	slug: 'crash-course',
	title: 'Crash course',
} as any

beforeEach(() => {
	vi.clearAllMocks()
	mocks.getCachedCohort.mockResolvedValue({
		fields: {
			startsAt: '2000-01-01T00:00:00.000Z',
			endsAt: '2999-01-01T00:00:00.000Z',
		},
	})
	mocks.getServerAuthSession.mockResolvedValue({
		session: { user: { id: 'owner-1' } },
		ability: { can: () => false },
	})
})

describe('courses hero running state', () => {
	it('an owner with no organization cookie still sees their running cohort', async () => {
		mocks.getCurrentOrganizationId.mockResolvedValue(null)
		mocks.memberships.mockResolvedValue([{ organizationId: 'org-a' }])
		mocks.checkCohortAccess.mockResolvedValue({ tier: 'x' })
		const state = await getCoursesHeroState(flagship)
		expect(state.running?.slug).toBe('crash-course')
		expect(mocks.checkCohortAccess).toHaveBeenCalledWith(
			'org-a',
			'owner-1',
			'crash-course',
		)
	})
	it('checks the cookie organization first and then the rest', async () => {
		mocks.getCurrentOrganizationId.mockResolvedValue('org-b')
		mocks.memberships.mockResolvedValue([
			{ organizationId: 'org-a' },
			{ organizationId: 'org-b' },
		])
		mocks.checkCohortAccess.mockImplementation(async (org: string) =>
			org === 'org-a' ? { tier: 'x' } : null,
		)
		const state = await getCoursesHeroState(flagship)
		expect(state.running).not.toBeNull()
		expect(mocks.checkCohortAccess.mock.calls.map(([org]) => org)).toEqual([
			'org-b',
			'org-a',
		])
	})
	it('a viewer with no membership and no cookie sees the pitch', async () => {
		mocks.getCurrentOrganizationId.mockResolvedValue(null)
		mocks.memberships.mockResolvedValue([])
		const state = await getCoursesHeroState(flagship)
		expect(state.running).toBeNull()
		expect(mocks.checkCohortAccess).not.toHaveBeenCalled()
	})
})
