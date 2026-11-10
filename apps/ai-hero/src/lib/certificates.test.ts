import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MySqlDialect } from 'drizzle-orm/mysql-core'

const mocks = vi.hoisted(() => ({ execute: vi.fn(), workshops: vi.fn() }))
vi.mock('@/db', () => ({ db: { execute: mocks.execute } }))
vi.mock('./cohorts-query', () => ({ getAllWorkshopsInCohort: mocks.workshops }))
vi.mock('@/server/logger', () => ({ log: { error: vi.fn() } }))
import {
	checkCertificateEligibility,
	checkCohortCertificateEligibility,
	checkCohortCertificateEligibilityFromWorkshops,
} from './certificates'
import { countRequiredModuleProgress } from './required-module-progress'
import type { Workshop } from './workshops'

const workshop = { id: 'before-we-start' } as Workshop
beforeEach(() => {
	vi.clearAllMocks()
	mocks.workshops.mockResolvedValue([workshop])
})
function completion(required = 1, incomplete = 0) {
	return {
		rows: [
			{
				required_lessons: required,
				incomplete_lessons: incomplete,
				last_completed_date: required ? '2026-11-01' : null,
			},
		],
	}
}

describe('optional lessons and certificates', () => {
	it('retains workshop completion, 100% progress and cohort eligibility when an optional FAQ is added', async () => {
		mocks.execute.mockResolvedValue(completion())
		const before = await checkCohortCertificateEligibility('cohort', 'learner')
		const after = await checkCohortCertificateEligibility('cohort', 'learner')
		expect(after).toEqual(before)
		expect(after.hasCompletedCohort).toBe(true)
		expect(
			(await checkCertificateEligibility(workshop.id, 'learner'))
				.hasCompletedModule,
		).toBe(true)
		const progress = countRequiredModuleProgress(
			{
				completedLessons: [
					{
						userId: 'learner',
						resourceId: 'required',
						completedAt: new Date(),
					},
				],
				nextResource: { id: 'faq' },
				completedLessonsCount: 1,
				totalLessonsCount: 2,
				percentCompleted: 50,
			},
			[
				{ id: 'required', type: 'lesson', slug: 'required', optional: false },
				{ id: 'faq', type: 'lesson', slug: 'faq', optional: true },
			],
		)
		expect(progress.percentCompleted).toBe(100)
		const sql = new MySqlDialect().sqlToQuery(
			mocks.execute.mock.calls[0]![0],
		).sql
		expect(sql).toContain("cr.fields->>'$.optional' = 'false'")
		expect(sql).toContain('cr.deletedAt IS NULL')
		expect(sql).toContain('crr.deletedAt IS NULL')
	})
	it('allows a zero-required workshop in both cohort eligibility entry points', async () => {
		mocks.execute.mockResolvedValue(completion(0))
		expect(
			await checkCohortCertificateEligibility('cohort', 'learner'),
		).toEqual({ hasCompletedCohort: true, date: null })
		expect(
			await checkCohortCertificateEligibilityFromWorkshops(
				[workshop],
				'learner',
			),
		).toEqual({ hasCompletedCohort: true, date: null })
		// Preserve the standalone empty-module certificate policy.
		expect(
			(await checkCertificateEligibility(workshop.id, 'learner'))
				.hasCompletedModule,
		).toBe(false)
	})
	it('still blocks incomplete required lessons and does not grant an empty cohort', async () => {
		mocks.execute.mockResolvedValue(completion(2, 1))
		expect(
			(await checkCohortCertificateEligibility('cohort', 'learner'))
				.hasCompletedCohort,
		).toBe(false)
		expect(
			(await checkCohortCertificateEligibilityFromWorkshops([], 'learner'))
				.hasCompletedCohort,
		).toBe(false)
	})
})
