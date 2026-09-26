import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	createFunction: vi.fn((options, trigger, handler) => ({
		options,
		trigger,
		handler,
	})),
	syncUser: vi.fn(
		async (): Promise<{
			toAdd: string[]
			toRemove: string[]
			updated: number
			refusedRemovals?: true
			unexpectedIdsCount?: number
		}> => ({
			toAdd: ['new'],
			toRemove: [],
			updated: 1,
			refusedRemovals: true,
			unexpectedIdsCount: 1,
		}),
	),
	info: vi.fn(async () => undefined),
}))
vi.mock('../inngest.server', () => ({
	inngest: { createFunction: mocks.createFunction },
}))
vi.mock('@/lib/entitlement-sync', () => ({
	syncUserCohortEntitlementsWithIds: mocks.syncUser,
}))
vi.mock('@/server/logger', () => ({ log: { info: mocks.info } }))

import { cohortEntitlementSyncUser } from './cohort-entitlement-sync-user'

const [, , handler] = mocks.createFunction.mock.calls[0]!
const run = (data: Record<string, unknown>) =>
	handler({
		event: {
			data: {
				cohortId: 'test-cohort',
				userId: 'buyer',
				userEmail: 'buyer@example.test',
				cohortResourceIds: ['new'],
				...data,
			},
		},
		step: {
			run: async (_id: string, operation: () => Promise<unknown>) =>
				operation(),
		},
	})

describe('cohort entitlement child event boundary', () => {
	it('passes bounded removals and run correlation, surfaces per-user refusal', async () => {
		expect(cohortEntitlementSyncUser).toBeDefined()
		mocks.syncUser.mockClear()
		mocks.info.mockClear()
		await expect(
			run({
				allowedRemovals: [],
				source: 'course-sync',
				controlPlaneRunId: 'run-1',
			}),
		).resolves.toMatchObject({
			status: 'refused',
			reason: 'bounded_removal',
			entitlementsAdded: 1,
			entitlementsRemoved: 0,
		})
		expect(mocks.syncUser).toHaveBeenCalledWith(
			'buyer',
			'test-cohort',
			['new'],
			{
				allowedRemovals: [],
				source: 'course-sync',
				controlPlaneRunId: 'run-1',
			},
		)
		expect(mocks.info).not.toHaveBeenCalledWith(
			'cohort_entitlement_sync_user.completed',
			expect.anything(),
		)
	})

	it('keeps the original CMS call and success result shape', async () => {
		mocks.syncUser.mockClear()
		mocks.syncUser.mockResolvedValueOnce({
			toAdd: ['new'],
			toRemove: ['old'],
			updated: 2,
		})
		await expect(run({})).resolves.toEqual({
			userId: 'buyer',
			userEmail: 'buyer@example.test',
			cohortId: 'test-cohort',
			entitlementsAdded: 1,
			entitlementsRemoved: 1,
		})
		expect(mocks.syncUser).toHaveBeenCalledWith('buyer', 'test-cohort', ['new'])
	})
})
