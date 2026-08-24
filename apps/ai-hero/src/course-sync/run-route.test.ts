import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apply } = vi.hoisted(() => ({
	apply: vi.fn(async () => ({ runId: 'run-1', state: 'applied' })),
}))

vi.mock('@/course-sync/runtime', () => ({
	courseSyncControlPlane: {
		apply,
		preview: vi.fn(),
		rollback: vi.fn(),
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
	beforeEach(() => apply.mockClear())

	it('rejects worker bearer for operator-policy apply', async () => {
		const response = await POST(request('test-worker-token-123456789'), context)

		expect(response.status).toBe(401)
		expect(apply).not.toHaveBeenCalled()
	})

	it('allows operator bearer to apply', async () => {
		const response = await POST(request('test-operator-token-1234567'), context)

		expect(response.status).toBe(200)
		expect(apply).toHaveBeenCalledWith({
			runId: 'run-1',
			idempotencyKey: 'apply-run-1',
		})
	})
})
