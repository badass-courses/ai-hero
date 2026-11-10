import { describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
	createFunction: vi.fn((_config, _trigger, handler) => handler),
	remind: vi.fn(async () => ({ reminded: true })),
}))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: mocks.createFunction },
}))
vi.mock('./stale-preview', () => ({
	remindStaleCourseSyncPreview: mocks.remind,
}))
vi.mock('./detection-persistence', () => ({
	appendCourseSyncPollLog: vi.fn(),
	claimCourseSyncReviewNotification: vi.fn(),
	completeCourseSyncReviewNotification: vi.fn(),
	failCourseSyncReviewNotification: vi.fn(),
	getCourseSyncPollState: vi.fn(),
}))
vi.mock('./runtime', () => ({
	courseSyncControlPlane: {
		getRun: vi.fn(),
		evaluateBoundedAutoApply: vi.fn(),
	},
}))
vi.mock('@/inngest/functions/course-sync-detection-poller', () => ({
	notifyCourseSync: vi.fn(),
}))
import { courseSyncStalePreview } from '@/inngest/functions/course-sync-stale-preview'
import { COURSE_SYNC_STALE_PREVIEW_EVENT } from '@/inngest/events/course-sync-stale-preview'

describe('stale preview durable timer', () => {
	it('registers its own event and sleeps until exactly 15 minutes after the posted hold', async () => {
		expect(mocks.createFunction).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'course-sync-stale-preview' }),
			{ event: COURSE_SYNC_STALE_PREVIEW_EVENT },
			expect.any(Function),
		)
		const data = {
			bindingId: 'binding-test',
			courseVersionId: 'version-test',
			controlPlaneRunId: 'run-test',
			planSha256: 'plan-test',
			heldAt: '2026-11-09T00:00:00.000Z',
		}
		const order: string[] = []
		const sleepUntil = vi.fn(async () => {
			order.push('sleep')
		})
		const run = vi.fn(async (_id: string, callback: () => Promise<unknown>) => {
			order.push('recheck')
			return callback()
		})
		const handler = mocks.createFunction.mock.calls[0]![2]
		await handler({ event: { data }, step: { sleepUntil, run } })
		expect(sleepUntil).toHaveBeenCalledWith(
			'wait-15-minutes-after-hold',
			new Date('2026-11-09T00:15:00.000Z'),
		)
		expect(order).toEqual(['sleep', 'recheck'])
		expect(mocks.remind).toHaveBeenCalledWith(
			data,
			expect.objectContaining({
				getPollState: expect.any(Function),
				getRun: expect.any(Function),
			}),
		)
		expect(courseSyncStalePreview).toBeDefined()
	})
})
