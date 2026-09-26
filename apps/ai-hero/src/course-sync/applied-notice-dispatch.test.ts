import { beforeEach, describe, expect, it, vi } from 'vitest'
import { syntheticCohortBinding } from './test-fixtures/cohort-binding'

const mocks = vi.hoisted(() => ({
	send: vi.fn(async (_event: unknown) => {}),
	logError: vi.fn(async (_event: string, _data: unknown) => {}),
	persisted: { bindingId: 'csb_ai_coding_crash_course' as string | null },
	select: vi.fn(),
}))

vi.mock('@/inngest/inngest.server', () => ({ inngest: { send: mocks.send } }))
vi.mock('@/db', () => ({ db: { select: mocks.select } }))
vi.mock('./types', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./types')>()
	return {
		...actual,
		getServerCourseSyncBinding: (id: string) =>
			id === syntheticCohortBinding.bindingId
				? syntheticCohortBinding
				: actual.getServerCourseSyncBinding(id),
	}
})
vi.mock('@/server/logger', () => ({
	log: { error: mocks.logError, info: vi.fn() },
}))

import { requestCourseSyncAppliedNotice } from './applied-notice-dispatch'

const input = {
	controlPlaneRunId: 'csr_run_1',
	requestedBy: 'operator' as const,
}

describe('course sync applied notice dispatch', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.send.mockResolvedValue(undefined)
		mocks.logError.mockResolvedValue(undefined)
		mocks.persisted.bindingId = 'csb_ai_coding_crash_course'
		mocks.select.mockImplementation(() => ({
			from: () => ({
				where: () => ({
					limit: async () =>
						mocks.persisted.bindingId
							? [{ bindingId: mocks.persisted.bindingId }]
							: [],
				}),
			}),
		}))
	})

	it('sends the event once when the first attempt succeeds', async () => {
		await requestCourseSyncAppliedNotice(input)

		expect(mocks.send).toHaveBeenCalledTimes(1)
		expect(mocks.send).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'course-sync/applied-notice.requested',
				data: expect.objectContaining({
					bindingId: 'csb_ai_coding_crash_course',
					controlPlaneRunId: 'csr_run_1',
					requestedBy: 'operator',
				}),
			}),
		)
		expect(mocks.logError).not.toHaveBeenCalled()
	})

	it('an operator v5 apply dispatches the persisted cohort binding, not the Crash Course default or a caller hint', async () => {
		mocks.persisted.bindingId = syntheticCohortBinding.bindingId
		const staleCallerHint = {
			...input,
			bindingId: 'csb_ai_coding_crash_course',
		}
		await requestCourseSyncAppliedNotice(staleCallerHint)
		expect(mocks.send).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					bindingId: syntheticCohortBinding.bindingId,
					controlPlaneRunId: 'csr_run_1',
					requestedBy: 'operator',
				}),
			}),
		)
	})

	it('throws when the persisted run is missing instead of sending a Crash Course notice', async () => {
		mocks.persisted.bindingId = null
		await expect(requestCourseSyncAppliedNotice(input)).rejects.toMatchObject({
			code: 'RUN_NOT_FOUND',
		})
		expect(mocks.send).not.toHaveBeenCalled()
	})

	it('retries a transient send failure instead of losing the notice', async () => {
		mocks.send.mockRejectedValueOnce(new Error('socket hang up'))

		await requestCourseSyncAppliedNotice(input)

		expect(mocks.send).toHaveBeenCalledTimes(2)
		expect(mocks.logError).not.toHaveBeenCalled()
	})

	it('gives up after the attempt budget and logs the binding', async () => {
		mocks.send.mockRejectedValue(new Error('inngest down'))

		await expect(requestCourseSyncAppliedNotice(input)).resolves.toBeUndefined()

		expect(mocks.send).toHaveBeenCalledTimes(3)
		expect(mocks.logError).toHaveBeenCalledWith(
			'course_sync.applied_notice.dispatch_failed',
			expect.objectContaining({
				bindingId: 'csb_ai_coding_crash_course',
				controlPlaneRunId: 'csr_run_1',
				requestedBy: 'operator',
				attempts: 3,
			}),
		)
	})

	it('never rejects the caller when logging the failure also fails', async () => {
		mocks.send.mockRejectedValue(new Error('inngest down'))
		mocks.logError.mockRejectedValue(new Error('logger down'))

		await expect(requestCourseSyncAppliedNotice(input)).resolves.toBeUndefined()
	})
})
