import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	createFunction: vi.fn((options, trigger, handler) => ({
		options,
		trigger,
		handler,
	})),
	getCohort: vi.fn(),
	findUsers: vi.fn(),
	info: vi.fn(async () => undefined),
	error: vi.fn(async () => undefined),
}))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: mocks.createFunction },
}))
vi.mock('@/lib/cohorts-query', () => ({ getCohort: mocks.getCohort }))
vi.mock('@/lib/entitlement-sync', () => ({
	findUsersWithCohortEntitlements: mocks.findUsers,
}))
vi.mock('@/server/logger', () => ({
	log: { info: mocks.info, error: mocks.error },
}))

import { COHORT_ENTITLEMENT_SYNC_USER_EVENT } from '../events/cohort-management'
import { cohortEntitlementSyncWorkflow } from './cohort-entitlement-sync-workflow'

const [, , workflowHandler] = mocks.createFunction.mock.calls[0]!
const user = (id: string) => ({
	user: { id, name: null, email: `${id}@example.test` },
})
const resource = (id: string, type = 'workshop') => ({ resource: { id, type } })
const run = async () => {
	const sendEvent = vi.fn(async () => undefined)
	expect(cohortEntitlementSyncWorkflow).toBeDefined()
	const result = await workflowHandler({
		event: { data: { cohortId: 'test-cohort', changes: {} } },
		step: {
			run: async (_id: string, operation: () => Promise<unknown>) =>
				operation(),
			sendEvent,
		},
	})
	return { result, sendEvent }
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.getCohort.mockResolvedValue({
		fields: { title: 'Test Cohort' },
		resources: [],
	})
	mocks.findUsers.mockResolvedValue([user('buyer-1'), user('buyer-2')])
})

describe('cohort entitlement sync empty-target safety', () => {
	it('refuses an empty workshop read for entitled users without fan-out or revocation', async () => {
		const { result, sendEvent } = await run()
		expect(result).toMatchObject({
			status: 'refused',
			reason: 'empty_target_with_entitlements',
			affectedUserCount: 2,
		})
		expect(sendEvent).not.toHaveBeenCalled()
		expect(mocks.error).toHaveBeenCalledWith(
			'cohort_entitlement_sync.empty_target_refused',
			expect.objectContaining({
				cohortId: 'test-cohort',
				affectedUserCount: 2,
			}),
		)
	})

	it('a single detached workshop sends only the remaining live workshop, for the existing diff to revoke', async () => {
		mocks.getCohort.mockResolvedValue({
			fields: { title: 'Test Cohort' },
			resources: [resource('kept-workshop')],
		})
		const { result, sendEvent } = await run()
		expect(result).toMatchObject({ usersProcessed: 2 })
		expect(sendEvent).toHaveBeenCalledTimes(1)
		expect(sendEvent).toHaveBeenCalledWith(
			'fan-out-user-sync-events-batch-0',
			expect.arrayContaining([
				expect.objectContaining({
					data: expect.objectContaining({
						cohortResourceIds: ['kept-workshop'],
					}),
				}),
			]),
		)
	})

	it('normal CMS saves keep their two workshop grants and skip non-workshop attachments', async () => {
		mocks.getCohort.mockResolvedValue({
			fields: { title: 'Test Cohort' },
			resources: [
				resource('workshop-a'),
				resource('reminder-email', 'email'),
				resource('workshop-b'),
			],
		})
		const { result, sendEvent } = await run()
		expect(result).toEqual({
			cohortId: 'test-cohort',
			cohortTitle: 'Test Cohort',
			usersProcessed: 2,
			message: 'Queued 2 user sync events',
		})
		expect(sendEvent).toHaveBeenCalledWith('fan-out-user-sync-events-batch-0', [
			{
				name: COHORT_ENTITLEMENT_SYNC_USER_EVENT,
				data: {
					cohortId: 'test-cohort',
					userId: 'buyer-1',
					userEmail: 'buyer-1@example.test',
					cohortResourceIds: ['workshop-a', 'workshop-b'],
				},
			},
			{
				name: COHORT_ENTITLEMENT_SYNC_USER_EVENT,
				data: {
					cohortId: 'test-cohort',
					userId: 'buyer-2',
					userEmail: 'buyer-2@example.test',
					cohortResourceIds: ['workshop-a', 'workshop-b'],
				},
			},
		])
	})

	it('an empty pre-purchase cohort is a quiet no-op', async () => {
		mocks.findUsers.mockResolvedValue([])
		const { result, sendEvent } = await run()
		expect(result).toMatchObject({
			usersProcessed: 0,
			message: 'No users with entitlements found - sync skipped',
		})
		expect(sendEvent).not.toHaveBeenCalled()
		expect(mocks.error).not.toHaveBeenCalled()
	})
})
