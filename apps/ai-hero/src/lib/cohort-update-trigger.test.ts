import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	send: vi.fn(async () => undefined),
	info: vi.fn(async () => undefined),
	error: vi.fn(async () => undefined),
}))
vi.mock('@/inngest/inngest.server', () => ({ inngest: { send: mocks.send } }))
vi.mock('@/server/logger', () => ({
	log: { info: mocks.info, error: mocks.error },
}))

import { triggerCohortEntitlementSync } from './cohort-update-trigger'

describe('cohort update trigger', () => {
	it('passes a stable event ID for course-sync retries without changing ordinary callers', async () => {
		await triggerCohortEntitlementSync(
			'test-cohort',
			{ resourcesAdded: [{ resourceId: 'workshop-1', position: 0 }] },
			'course-sync-entitlement-stable',
		)
		expect(mocks.send).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'course-sync-entitlement-stable' }),
		)
		mocks.send.mockClear()
		await triggerCohortEntitlementSync('test-cohort', {})
		expect(mocks.send).toHaveBeenCalledWith(
			expect.not.objectContaining({ id: expect.anything() }),
		)
	})
})
