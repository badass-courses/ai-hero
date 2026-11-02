import { describe, expect, it, vi } from 'vitest'
import { MySqlDialect } from 'drizzle-orm/mysql-core'

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(
		async (_options: { with?: Record<string, unknown> }) => null,
	),
	where: vi.fn(),
	logError: vi.fn(),
	logDebug: vi.fn(),
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: {},
	db: {
		query: { contentResource: { findFirst: mocks.findFirst } },
		select: () => ({
			from: () => ({
				innerJoin: () => ({
					where: (predicate: unknown) => {
						mocks.where(predicate)
						return { orderBy: async () => [] }
					},
				}),
			}),
		}),
	},
}))
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/server/auth', () => ({ getServerAuthSession: vi.fn() }))
vi.mock('@/ability', () => ({ createAppAbility: vi.fn() }))
vi.mock('@/inngest/inngest.server', () => ({ inngest: {} }))
vi.mock('./progress', () => ({ getModuleProgressForUser: vi.fn() }))
vi.mock('./pricing-query', () => ({ getPricingData: vi.fn() }))
vi.mock('./sale-banner', () => ({ getSaleBannerData: vi.fn() }))
vi.mock('./entitlements-query', () => ({ getAllUserEntitlements: vi.fn() }))
vi.mock('./certificates', () => ({
	checkCohortCertificateEligibilityFromWorkshops: vi.fn(),
}))
vi.mock('@/server/logger', () => ({
	log: { error: mocks.logError, debug: mocks.logDebug },
}))
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }))
vi.mock('next/headers', () => ({ headers: vi.fn() }))

import { getAllWorkshopsInCohort, getCohort } from './cohorts-query'

const sqlText = (predicate: unknown) =>
	new MySqlDialect()
		.sqlToQuery(predicate as Parameters<MySqlDialect['sqlToQuery']>[0])
		.sql.toLowerCase()

describe('cohort live relation readers', () => {
	it('getAllWorkshopsInCohort excludes tombstoned workshop relations', async () => {
		await expect(getAllWorkshopsInCohort('test-cohort')).resolves.toEqual([])
		expect(sqlText(mocks.where.mock.calls.at(-1)?.[0])).toContain(
			'deletedat` is null',
		)
	})

	it('getCohort excludes detached workshop and lesson relations', async () => {
		await getCohort('test-cohort')
		const options = mocks.findFirst.mock.calls.at(-1)?.[0] as
			| {
					with: {
						resources: {
							where: unknown
							with: { resource: { with: { resources: { where: unknown } } } }
						}
					}
			  }
			| undefined
		if (!options) throw new Error('cohort query did not execute')
		expect(sqlText(options.with.resources.where)).toContain(
			'deletedat` is null',
		)
		expect(
			sqlText(options.with.resources.with.resource.with.resources.where),
		).toContain('deletedat` is null')
	})
})

describe('getCohort not-found handling', () => {
	it('is null with a debug log and no error log when no row matches', async () => {
		mocks.logError.mockClear()
		mocks.logDebug.mockClear()
		mocks.findFirst.mockResolvedValueOnce(null)

		await expect(getCohort('missing-cohort')).resolves.toBeNull()
		expect(mocks.logDebug).toHaveBeenCalledWith('cohort.not_found', {
			slugOrId: 'missing-cohort',
		})
		expect(mocks.logError).not.toHaveBeenCalled()
	})

	it('still logs cohort.parse.error for a malformed row', async () => {
		mocks.logError.mockClear()
		mocks.findFirst.mockResolvedValueOnce({ id: 'cohort-1' } as never)

		await expect(getCohort('cohort-1')).resolves.toBeNull()
		expect(mocks.logError).toHaveBeenCalledWith(
			'cohort.parse.error',
			expect.objectContaining({ cohortId: 'cohort-1' }),
		)
	})
})
