import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
	resource: vi.fn(),
	type: vi.fn(),
	entitlements: vi.fn(),
}))
vi.mock('@/db', () => ({
	db: {
		query: {
			contentResource: { findFirst: mocks.resource },
			entitlementTypes: { findFirst: mocks.type },
			entitlements: { findMany: mocks.entitlements },
		},
	},
}))
import { getCohortWelcomeDetails } from './cohort-welcome-details-query'

beforeEach(() => {
	vi.resetAllMocks()
	mocks.resource.mockResolvedValueOnce({
		id: 'cohort-xdy1m',
		type: 'cohort',
		fields: { title: 'AI Coding for Real Engineers' },
		resources: [],
	})
	mocks.type.mockResolvedValue({ id: 'workshop-type' })
	mocks.entitlements.mockResolvedValue([])
})
describe('send-time welcome loader', () => {
	it('does not read or alter another cohort', async () => {
		expect(
			await getCohortWelcomeDetails('cohort-other', 'user'),
		).toBeUndefined()
		expect(mocks.resource).not.toHaveBeenCalled()
	})
	it('does not promise Crash Course access without an active entitlement', async () => {
		expect(
			(await getCohortWelcomeDetails('cohort-xdy1m', 'user'))?.crashCourseUrl,
		).toBeUndefined()
		expect(mocks.entitlements).toHaveBeenCalledOnce()
	})
	it('links the current Crash Course slug after an active content entitlement readback', async () => {
		mocks.entitlements.mockResolvedValue([
			{ metadata: { contentIds: ['workshop-2ozd9'] } },
		])
		mocks.resource.mockResolvedValueOnce({
			fields: { slug: 'current-crash-course' },
		})
		expect(
			(await getCohortWelcomeDetails('cohort-xdy1m', 'user'))?.crashCourseUrl,
		).toContain('/workshops/current-crash-course')
	})
	it('ignores unrelated content access', async () => {
		mocks.entitlements.mockResolvedValue([
			{ metadata: { contentIds: ['other'] } },
		])
		expect(
			(await getCohortWelcomeDetails('cohort-xdy1m', 'user'))?.crashCourseUrl,
		).toBeUndefined()
	})
})
