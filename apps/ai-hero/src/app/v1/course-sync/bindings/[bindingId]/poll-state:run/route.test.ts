import { beforeEach, describe, expect, it, vi } from 'vitest'

const send = vi.hoisted(() => vi.fn())

vi.mock('@/env.mjs', () => ({
	env: {
		COURSE_SYNC_STAGE_TOKEN: 'stage-token-for-tests-1234',
		COURSE_SYNC_WORKER_TOKEN: 'worker-token-for-tests-123',
		COURSE_SYNC_OPERATOR_TOKEN: 'operator-token-for-tests-1',
	},
}))

vi.mock('@/inngest/inngest.server', () => ({
	inngest: { send },
}))

import { POST } from './route'

const bindingId = 'csb_ai_coding_crash_course'
const context = { params: Promise.resolve({ bindingId }) }

function request(headers: Record<string, string>) {
	return new Request(
		`https://www.aihero.dev/v1/course-sync/bindings/${bindingId}/poll-state:run`,
		{ method: 'POST', headers },
	)
}

describe('course sync poll run-now route', () => {
	beforeEach(() => {
		send.mockReset()
		send.mockResolvedValue({ ids: ['evt_1'] })
	})

	it('queues one idempotent operator-requested poll', async () => {
		const response = await POST(
			request({
				authorization: 'Bearer operator-token-for-tests-1',
				'idempotency-key': 'release-recovery-2026-08-21',
			}),
			context,
		)

		expect(response.status).toBe(202)
		await expect(response.json()).resolves.toMatchObject({
			accepted: true,
			bindingId,
			inngestEventIds: ['evt_1'],
		})
		expect(send).toHaveBeenCalledWith({
			id: expect.stringMatching(/^course-sync-poll:[a-f0-9]{64}$/),
			name: 'course-sync/poll.requested',
			data: {
				bindingId,
				requestedBy: 'operator',
				reason: 'operator-requested-run-now',
			},
		})
	})

	it('rejects requests without the operator token', async () => {
		const response = await POST(
			request({ 'idempotency-key': 'unauthorized' }),
			context,
		)

		expect(response.status).toBe(401)
		expect(send).not.toHaveBeenCalled()
	})
})
