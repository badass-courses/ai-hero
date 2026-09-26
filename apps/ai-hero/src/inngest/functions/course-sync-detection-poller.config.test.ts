import { describe, expect, it, vi } from 'vitest'

const createFunction = vi.hoisted(() =>
	vi.fn((options, trigger, handler) => ({ options, trigger, handler })),
)
const poll = vi.hoisted(() => vi.fn(async (runId: string) => ({ runId })))
const createPoller = vi.hoisted(() => vi.fn(() => poll))
const recordFailure = vi.hoisted(() => vi.fn(async () => undefined))
const info = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../inngest.server', () => ({ inngest: { createFunction } }))
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/server/logger', () => ({ log: { info } }))
vi.mock('@/course-sync/detection-poller', () => ({
	createCourseSyncDetectionPoller: createPoller,
	recordCourseSyncPollFailure: recordFailure,
}))
vi.mock('@/course-sync/applied-notice', () => ({
	deliverCourseSyncAppliedNotice: vi.fn(),
	sendCourseSyncSlackPayload: vi.fn(),
}))
vi.mock('@/course-sync/detection-persistence', () => ({}))
vi.mock('@/course-sync/freeze-batches', () => ({}))
vi.mock('@/course-sync/runtime', () => ({ courseSyncControlPlane: {} }))
vi.mock('@/lib/dropbox-course-sync', () => ({}))

import { COURSE_SYNC_POLL_REQUESTED_EVENT } from '../events/course-sync-poll'
import {
	courseSyncDetectionPoller,
	originalFailureBindingId,
} from './course-sync-detection-poller'

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
		expect(
			originalFailureBindingId({
				data: { event: { data: { bindingId: 'binding-a' } } },
			}),
		).toBe('binding-a')
		expect(
			originalFailureBindingId({ data: { event: { data: {} } } }),
		).toBeNull()
		await expect(
			handler({
				event: { data: { bindingId: 'unknown' } },
				step: {},
				runId: 'run',
			}),
		).rejects.toMatchObject({ code: 'BINDING_NOT_FOUND', status: 404 })
	})

	it('replays a legacy cron with no event as Crash Course, visibly (red proof)', async () => {
		const [, , handler] = createFunction.mock.calls[0]!
		await expect(
			handler({ event: undefined, step: {}, runId: 'legacy-cron' }),
		).resolves.toEqual({ runId: 'legacy-cron' })
		expect(createPoller).toHaveBeenCalledWith(
			expect.objectContaining({
				binding: expect.objectContaining({
					bindingId: 'csb_ai_coding_crash_course',
				}),
			}),
		)
		expect(info).toHaveBeenCalledWith(
			'course_sync.legacy_cron_compat',
			expect.objectContaining({ runId: 'legacy-cron' }),
		)
	})

	it('accepts old-shape events without bindingId as legacy polls', async () => {
		const [, , handler] = createFunction.mock.calls[0]!
		createPoller.mockClear()
		await expect(
			handler({ event: { data: {} }, step: {}, runId: 'old-shape' }),
		).resolves.toEqual({ runId: 'old-shape' })
		expect(createPoller).toHaveBeenCalledWith(
			expect.objectContaining({
				binding: expect.objectContaining({
					bindingId: 'csb_ai_coding_crash_course',
				}),
			}),
		)
	})

	it('records legacy cron failures on Crash Course rather than skipping them', async () => {
		const [options] = createFunction.mock.calls[0]!
		await options.onFailure({
			event: { data: { event: undefined } },
			step: { run: vi.fn(async (_key: string, fn: () => unknown) => fn()) },
			runId: 'failed-legacy',
		})
		expect(recordFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				binding: expect.objectContaining({
					bindingId: 'csb_ai_coding_crash_course',
				}),
			}),
			expect.objectContaining({
				bindingId: 'csb_ai_coding_crash_course',
				runId: 'failed-legacy',
			}),
		)
		expect(info).toHaveBeenCalledWith(
			'course_sync.legacy_cron_compat',
			expect.objectContaining({ runId: 'failed-legacy' }),
		)
		await options.onFailure({
			event: { data: { event: { data: {} } } },
			step: { run: vi.fn(async (_key: string, fn: () => unknown) => fn()) },
			runId: 'failed-old-shape',
		})
		expect(recordFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				binding: expect.objectContaining({
					bindingId: 'csb_ai_coding_crash_course',
				}),
			}),
			expect.objectContaining({
				bindingId: 'csb_ai_coding_crash_course',
				runId: 'failed-old-shape',
			}),
		)
	})

	it('does not fall back for an explicit unknown binding, but leaves normal events alone', async () => {
		const [, , handler] = createFunction.mock.calls[0]!
		await expect(
			handler({
				event: { data: { bindingId: 'unknown' } },
				step: {},
				runId: 'unknown',
			}),
		).rejects.toMatchObject({ code: 'BINDING_NOT_FOUND', status: 404 })
		expect(createPoller).not.toHaveBeenCalledWith(
			expect.objectContaining({
				binding: expect.objectContaining({ bindingId: 'unknown' }),
			}),
		)
		const [options] = createFunction.mock.calls[0]!
		await expect(
			options.onFailure({
				event: { data: { event: { data: { bindingId: 'unknown' } } } },
				step: {},
				runId: 'failed-unknown',
			}),
		).rejects.toMatchObject({ code: 'BINDING_NOT_FOUND', status: 404 })
		info.mockClear()
		await expect(
			handler({
				event: { data: { bindingId: 'csb_ai_coding_crash_course' } },
				step: {},
				runId: 'normal',
			}),
		).resolves.toEqual({ runId: 'normal' })
		expect(info).not.toHaveBeenCalled()
	})
})
