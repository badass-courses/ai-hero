import { beforeEach, describe, expect, it, vi } from 'vitest'
import { syntheticCohortBinding } from './test-fixtures/cohort-binding'
import { CourseSyncError } from './errors'

const {
	apply,
	rollback,
	entitlementSync,
	requestCourseSyncAppliedNotice,
	select,
	persisted,
	claimNotice,
	failNotice,
	logError,
} = vi.hoisted(() => ({
	persisted: { bindingId: 'csb_test_cohort' as string | null },
	select: vi.fn(),
	claimNotice: vi.fn(async () => true),
	failNotice: vi.fn(async () => undefined),
	logError: vi.fn(async () => undefined),
	apply: vi.fn(async () => ({
		runId: 'run-1',
		state: 'applied',
		bindingId: 'csb_test_cohort',
		courseVersionId: 'version-1',
		planSha256: 'plan-sha',
	})),
	rollback: vi.fn(async () => ({
		runId: 'run-1',
		state: 'rolled_back',
		bindingId: 'csb_test_cohort',
		courseVersionId: 'version-1',
		planSha256: 'plan-sha',
	})),
	entitlementSync: vi.fn(
		async (): Promise<{ triggered: boolean; reason?: string }> => ({
			triggered: true,
		}),
	),
	requestCourseSyncAppliedNotice: vi.fn(async () => {}),
}))

vi.mock('@/db', () => ({ db: { select } }))
vi.mock('@/course-sync/detection-persistence', () => ({
	claimCourseSyncReviewNotification: claimNotice,
	failCourseSyncReviewNotification: failNotice,
}))
vi.mock('@/server/logger', () => ({ log: { error: logError, info: vi.fn() } }))
vi.mock('@/course-sync/cohort-entitlements', () => ({
	deliverCourseSyncEntitlementSync: entitlementSync,
}))
vi.mock('@/course-sync/types', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./types')>()
	return {
		...actual,
		COURSE_SYNC_BINDINGS: {
			...actual.COURSE_SYNC_BINDINGS,
			[syntheticCohortBinding.bindingId]: syntheticCohortBinding,
		},
		getServerCourseSyncBinding: (id: string) =>
			id === syntheticCohortBinding.bindingId
				? syntheticCohortBinding
				: actual.getServerCourseSyncBinding(id),
	}
})
vi.mock('@/course-sync/applied-notice-dispatch', () => ({
	requestCourseSyncAppliedNotice,
}))

vi.mock('@/course-sync/runtime', () => ({
	courseSyncControlPlane: {
		apply,
		preview: vi.fn(),
		rollback,
		getRun: vi.fn(),
	},
}))

import { POST } from '@/app/v1/course-sync/runs/[runOperation]/route'

function request(token: string) {
	return new Request('https://www.aihero.dev/v1/course-sync/runs/run-1:apply', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Idempotency-Key': 'apply-run-1',
		},
	})
}

const context = {
	params: Promise.resolve({ runOperation: 'run-1:apply' }),
}

describe('course sync run operation route', () => {
	beforeEach(() => {
		apply.mockClear()
		requestCourseSyncAppliedNotice.mockClear()
		rollback.mockClear()
		entitlementSync.mockClear()
		claimNotice.mockClear()
		failNotice.mockClear()
		logError.mockClear()
		requestCourseSyncAppliedNotice.mockResolvedValue(undefined)
		persisted.bindingId = syntheticCohortBinding.bindingId
		select.mockImplementation(() => ({
			from: () => ({
				where: () => ({
					limit: async () =>
						persisted.bindingId ? [{ bindingId: persisted.bindingId }] : [],
				}),
			}),
		}))
	})

	it('rejects worker bearer for operator-policy apply', async () => {
		const response = await POST(request('test-worker-token-123456789'), context)

		expect(response.status).toBe(401)
		expect(apply).not.toHaveBeenCalled()
		expect(requestCourseSyncAppliedNotice).not.toHaveBeenCalled()
	})

	it('allows operator bearer to apply', async () => {
		const response = await POST(request('test-operator-token-1234567'), context)

		expect(response.status).toBe(200)
		expect(apply).toHaveBeenCalledWith({
			runId: 'run-1',
			idempotencyKey: 'apply-run-1',
		})
	})

	it('asks for the applied notice after an operator apply', async () => {
		await POST(request('test-operator-token-1234567'), context)

		expect(requestCourseSyncAppliedNotice).toHaveBeenCalledWith({
			controlPlaneRunId: 'run-1',
			requestedBy: 'operator',
		})
	})

	it('returns the durable v5 apply on a transient notice lookup error and records a retryable receipt', async () => {
		requestCourseSyncAppliedNotice.mockRejectedValueOnce(
			new Error('transient binding lookup'),
		)
		const response = await POST(request('test-operator-token-1234567'), context)
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			runId: 'run-1',
			state: 'applied',
		})
		expect(claimNotice).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'applied',
				bindingId: syntheticCohortBinding.bindingId,
				controlPlaneRunId: 'run-1',
				planSha256: 'plan-sha',
			}),
		)
		expect(failNotice).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'applied',
				failureClass: 'APPLIED_NOTICE_BINDING_LOOKUP_FAILED',
			}),
		)
		expect(logError).toHaveBeenCalledWith(
			'course_sync.post_commit_notice.lookup_failed',
			expect.objectContaining({
				runId: 'run-1',
				phase: 'apply',
				receiptRecorded: true,
			}),
		)
		// The same idempotency key re-enters applied state and redelivers the notice.
		const retry = await POST(request('test-operator-token-1234567'), context)
		expect(retry.status).toBe(200)
		expect(requestCourseSyncAppliedNotice).toHaveBeenCalledTimes(2)
	})

	it('keeps the durable apply response even when recording the failed notice also fails', async () => {
		requestCourseSyncAppliedNotice.mockRejectedValueOnce(
			new Error('binding lookup failed'),
		)
		claimNotice.mockRejectedValueOnce(new Error('receipt database unavailable'))
		const response = await POST(request('test-operator-token-1234567'), context)
		expect(response.status).toBe(200)
		expect(logError).toHaveBeenCalledWith(
			'course_sync.post_commit_notice.lookup_failed',
			expect.objectContaining({
				runId: 'run-1',
				phase: 'apply',
				receiptRecorded: false,
				receiptError: 'receipt database unavailable',
			}),
		)
	})

	it('a genuinely missing run fails before apply and records no notice failure', async () => {
		apply.mockRejectedValueOnce(
			new CourseSyncError('RUN_NOT_FOUND', 'Sync run not found.', 404),
		)
		const response = await POST(request('test-operator-token-1234567'), context)
		expect(response.status).toBe(404)
		expect(requestCourseSyncAppliedNotice).not.toHaveBeenCalled()
		expect(claimNotice).not.toHaveBeenCalled()
	})

	it('syncs cohort entitlements after rollback but not after a v4 rollback', async () => {
		const rollbackContext = {
			params: Promise.resolve({ runOperation: 'run-1:rollback' }),
		}
		const response = await POST(
			request('test-operator-token-1234567'),
			rollbackContext,
		)
		expect(response.status).toBe(200)
		expect(entitlementSync).toHaveBeenCalledWith({
			controlPlaneRunId: 'run-1',
			lifecycle: 'rolled_back',
		})
		entitlementSync.mockClear()
		persisted.bindingId = 'csb_ai_coding_crash_course'
		rollback.mockResolvedValueOnce({
			runId: 'run-1',
			state: 'rolled_back',
			bindingId: syntheticCohortBinding.bindingId,
			courseVersionId: 'version-1',
			planSha256: 'plan-sha',
		})
		expect(
			(await POST(request('test-operator-token-1234567'), rollbackContext))
				.status,
		).toBe(200)
		expect(entitlementSync).not.toHaveBeenCalled()
	})

	it('rollback uses the persisted v5 binding even if its returned run claims v4', async () => {
		rollback.mockResolvedValueOnce({
			runId: 'run-1',
			state: 'rolled_back',
			bindingId: 'csb_ai_coding_crash_course',
			courseVersionId: 'version-1',
			planSha256: 'plan-sha',
		})
		const response = await POST(request('test-operator-token-1234567'), {
			params: Promise.resolve({ runOperation: 'run-1:rollback' }),
		})
		expect(response.status).toBe(200)
		expect(entitlementSync).toHaveBeenCalledWith({
			controlPlaneRunId: 'run-1',
			lifecycle: 'rolled_back',
		})
	})

	it('rollback records a v5 lookup failure after commit and returns the durable result', async () => {
		select.mockImplementationOnce(() => ({
			from: () => ({
				where: () => ({
					limit: async () => {
						throw new Error('transient lookup')
					},
				}),
			}),
		}))
		const rollbackContext = {
			params: Promise.resolve({ runOperation: 'run-1:rollback' }),
		}
		const response = await POST(
			request('test-operator-token-1234567'),
			rollbackContext,
		)
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			runId: 'run-1',
			state: 'rolled_back',
		})
		expect(entitlementSync).not.toHaveBeenCalled()
		expect(failNotice).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'entitlement-rolled-back',
				failureClass: 'COHORT_ENTITLEMENT_BINDING_LOOKUP_FAILED',
			}),
		)
		expect(logError).toHaveBeenCalledWith(
			'course_sync.post_commit_notice.lookup_failed',
			expect.objectContaining({
				runId: 'run-1',
				phase: 'rollback',
				receiptRecorded: true,
			}),
		)
		const redelivery = await POST(
			request('test-operator-token-1234567'),
			rollbackContext,
		)
		expect(redelivery.status).toBe(200)
		expect(entitlementSync).toHaveBeenCalledWith({
			controlPlaneRunId: 'run-1',
			lifecycle: 'rolled_back',
		})
	})

	it('v4 rollback has no entitlement receipt even if the post-commit lookup fails', async () => {
		persisted.bindingId = 'csb_ai_coding_crash_course'
		rollback.mockResolvedValueOnce({
			runId: 'run-1',
			state: 'rolled_back',
			bindingId: 'csb_ai_coding_crash_course',
			courseVersionId: 'version-1',
			planSha256: 'plan-sha',
		})
		select.mockImplementationOnce(() => ({
			from: () => ({
				where: () => ({
					limit: async () => {
						throw new Error('transient lookup')
					},
				}),
			}),
		}))
		const response = await POST(request('test-operator-token-1234567'), {
			params: Promise.resolve({ runOperation: 'run-1:rollback' }),
		})
		expect(response.status).toBe(200)
		expect(entitlementSync).not.toHaveBeenCalled()
		expect(failNotice).not.toHaveBeenCalled()
	})

	it('a truly missing rollback run fails before rollback', async () => {
		rollback.mockRejectedValueOnce(
			new CourseSyncError('RUN_NOT_FOUND', 'Sync run not found.', 404),
		)
		const response = await POST(request('test-operator-token-1234567'), {
			params: Promise.resolve({ runOperation: 'run-1:rollback' }),
		})
		expect(response.status).toBe(404)
		expect(entitlementSync).not.toHaveBeenCalled()
		expect(failNotice).not.toHaveBeenCalled()
	})

	it('returns a successful rollback even when cohort entitlement dispatch fails', async () => {
		entitlementSync.mockResolvedValueOnce({
			triggered: false,
			reason: 'failed',
		})
		const response = await POST(request('test-operator-token-1234567'), {
			params: Promise.resolve({ runOperation: 'run-1:rollback' }),
		})
		expect(response.status).toBe(200)
		expect(entitlementSync).toHaveBeenCalledOnce()
	})

	it('stays silent when apply did not reach the applied state', async () => {
		apply.mockResolvedValueOnce({
			runId: 'run-1',
			state: 'previewed',
			bindingId: syntheticCohortBinding.bindingId,
			courseVersionId: 'version-1',
			planSha256: 'plan-sha',
		})

		await POST(request('test-operator-token-1234567'), context)

		expect(requestCourseSyncAppliedNotice).not.toHaveBeenCalled()
	})
})
