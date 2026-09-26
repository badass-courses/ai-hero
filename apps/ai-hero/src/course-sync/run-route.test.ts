import { beforeEach, describe, expect, it, vi } from 'vitest'
import { syntheticCohortBinding } from './test-fixtures/cohort-binding'

const { apply, rollback, entitlementSync, requestCourseSyncAppliedNotice } =
	vi.hoisted(() => ({
		apply: vi.fn(async () => ({ runId: 'run-1', state: 'applied' })),
		rollback: vi.fn(async () => ({
			runId: 'run-1',
			state: 'rolled_back',
			bindingId: 'csb_test_cohort',
		})),
		entitlementSync: vi.fn(
			async (): Promise<{ triggered: boolean; reason?: string }> => ({
				triggered: true,
			}),
		),
		requestCourseSyncAppliedNotice: vi.fn(async () => {}),
	}))

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
		rollback.mockResolvedValueOnce({
			runId: 'run-1',
			state: 'rolled_back',
			bindingId: 'csb_ai_coding_crash_course',
		})
		expect(
			(await POST(request('test-operator-token-1234567'), rollbackContext))
				.status,
		).toBe(200)
		expect(entitlementSync).not.toHaveBeenCalled()
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
		apply.mockResolvedValueOnce({ runId: 'run-1', state: 'previewed' })

		await POST(request('test-operator-token-1234567'), context)

		expect(requestCourseSyncAppliedNotice).not.toHaveBeenCalled()
	})
})
