import { MySqlDialect } from 'drizzle-orm/mysql-core'
import type { SQL } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	rows: [] as Array<{
		id: string
		entitlementType: string
		organizationMembershipId: string
		userId: null
		expiresAt: Date | null
		deletedAt: Date | null
		metadata: { contentIds: string[] }
	}>,
	findMemberships: vi.fn(),
	findEntitlements: vi.fn(),
	getWorkshop: vi.fn(),
	getLesson: vi.fn(),
	getSession: vi.fn(),
}))
vi.mock('@/db', () => ({
	db: {
		query: {
			organizationMemberships: { findMany: mocks.findMemberships },
			entitlements: { findMany: mocks.findEntitlements },
			entitlementTypes: {
				findMany: async () => [
					{ id: 'cohort-type', name: 'cohort_content_access' },
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
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/lib/convertkit', () => ({
	getSubscriberFromCookie: async () => null,
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

import { getAllUserEntitlements } from '@/lib/entitlements-query'
import { getAbilityForResource } from './get-current-ability-rules'
import { cohortAbilityFixture } from '@/ability/test-fixtures/cohort-content-scope'

const dialect = new MySqlDialect()
const row = (
	id: string,
	membership: string,
	contentIds: string[],
	overrides = {},
) => ({
	id,
	entitlementType: 'cohort-type',
	organizationMembershipId: membership,
	userId: null,
	expiresAt: null,
	deletedAt: null,
	metadata: { contentIds },
	...overrides,
})

describe('loaded cohort entitlement scope', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-11-10T00:00:00.000Z'))
		const fixture = cohortAbilityFixture({ contentIds: [] })
		mocks.getSession.mockResolvedValue({ session: { user: fixture.user } })
		mocks.getWorkshop.mockResolvedValue(fixture.module)
		mocks.getLesson.mockResolvedValue(fixture.lesson)
		mocks.findMemberships.mockResolvedValue(fixture.user.memberships)
		mocks.rows = [
			row('active-a', 'membership-a', ['unrelated-workshop']),
			row('active-b', 'membership-b', ['another-unrelated-workshop']),
			row('expired-owned', 'membership-b', ['requested-workshop'], {
				expiresAt: new Date('2026-11-01T00:00:00.000Z'),
			}),
			row('deleted-owned', 'membership-b', ['requested-workshop'], {
				deletedAt: new Date('2026-11-01T00:00:00.000Z'),
			}),
			row('foreign-member', 'membership-foreign', ['requested-workshop']),
		]
		mocks.findEntitlements.mockImplementation(
			async ({ where }: { where: SQL }) => {
				const { sql, params } = dialect.sqlToQuery(where)
				// Execute the filters only when the real loader supplied them. A
				// removed membership/deletion/expiry predicate makes a test fail.
				const filtersMembership = sql.includes('`organizationMembershipId` in')
				const filtersDeleted = sql.includes('`deletedAt` is null')
				const filtersExpiry =
					sql.includes('`expiresAt` is null') &&
					sql.includes('`expiresAt` > CURRENT_TIMESTAMP')
				return mocks.rows.filter(
					(entry) =>
						(!filtersMembership ||
							params.includes(entry.organizationMembershipId)) &&
						(!filtersDeleted || entry.deletedAt === null) &&
						(!filtersExpiry ||
							entry.expiresAt === null ||
							entry.expiresAt.getTime() > Date.now()),
				)
			},
		)
	})
	afterEach(() => { vi.useRealTimers() })

	it('loads active team membership-linked rows across organizations, excluding expired, deleted and foreign memberships', async () => {
		const rows = await getAllUserEntitlements('synthetic-viewer')
		expect(rows.map((entry) => entry.id)).toEqual(['active-a', 'active-b'])
		const membershipQuery = mocks.findMemberships.mock.calls[0]![0].where
		expect(dialect.sqlToQuery(membershipQuery).params).toEqual([
			'synthetic-viewer',
		])
	})

	it('does not let all active organization entitlements grant an unrelated direct lesson', async () => {
		await expect(
			getAbilityForResource('paid-lesson', 'requested-workshop'),
		).resolves.toMatchObject({
			canViewLesson: false,
			canViewWorkshop: false,
			isPendingOpenAccess: false,
		})
		expect(mocks.findEntitlements).toHaveBeenCalledOnce()
	})

	it('allows a legitimately scoped team entitlement without requiring a purchase', async () => {
		mocks.rows.push(
			row('owned-team-seat', 'membership-b', ['requested-workshop']),
		)
		await expect(
			getAbilityForResource('paid-lesson', 'requested-workshop'),
		).resolves.toMatchObject({ canViewLesson: true, canViewWorkshop: true })
	})

	it('does not use unrelated team rows to grant pending access to a future module', async () => {
		mocks.getWorkshop.mockResolvedValue(
			cohortAbilityFixture({ startsAt: '2026-12-09T08:01:00.000Z' }).module,
		)
		await expect(
			getAbilityForResource('paid-lesson', 'requested-workshop'),
		).resolves.toMatchObject({
			canViewLesson: false,
			isPendingOpenAccess: false,
		})
	})
})
