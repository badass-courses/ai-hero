import { describe, expect, it, vi } from 'vitest'

const createFunction = vi.hoisted(() =>
	vi.fn((options, trigger, handler) => ({ options, trigger, handler })),
)
vi.mock('../inngest.server', () => ({ inngest: { createFunction } }))
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/course-sync/applied-notice', () => ({
	deliverCourseSyncAppliedNotice: vi.fn(),
	sendCourseSyncSlackPayload: vi.fn(),
}))
vi.mock('@/course-sync/detection-persistence', () => ({}))
vi.mock('@/course-sync/freeze-batches', () => ({}))
vi.mock('@/course-sync/runtime', () => ({ courseSyncControlPlane: {} }))
vi.mock('@/lib/dropbox-course-sync', () => ({}))

import { COURSE_SYNC_POLL_REQUESTED_EVENT } from '../events/course-sync-poll'
import { courseSyncDetectionPoller, originalFailureBindingId } from './course-sync-detection-poller'

describe('course-sync detection poller registration', () => {
	it('is event-only and serializes each binding independently', async () => {
		expect(courseSyncDetectionPoller).toBeDefined()
		const [options, trigger, handler] = createFunction.mock.calls[0]!
		expect(options).toMatchObject({
			id: 'ai-hero-course-sync-detection-poller',
			concurrency: { limit: 1, key: 'event.data.bindingId' },
			retries: 0,
		})
		expect(trigger).toEqual({ event: COURSE_SYNC_POLL_REQUESTED_EVENT })
		expect(originalFailureBindingId({ data: { event: { data: { bindingId: 'binding-a' } } } })).toBe('binding-a')
		expect(originalFailureBindingId({ data: { event: { data: {} } } })).toBeNull()
		await expect(
			handler({
				event: { data: { bindingId: 'unknown' } },
				step: {},
				runId: 'run',
			}),
		).rejects.toMatchObject({ code: 'BINDING_NOT_FOUND', status: 404 })
	})
})
