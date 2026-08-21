import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn())
vi.stubGlobal('fetch', fetchMock)

vi.mock('@/env.mjs', () => ({
	env: {
		COURSE_SYNC_STAGE_TOKEN: 'stage-token-for-tests-1234',
		COURSE_SYNC_WORKER_TOKEN: 'worker-token-for-tests-123',
		COURSE_SYNC_OPERATOR_TOKEN: 'operator-token-for-tests-1',
		INNGEST_SIGNING_KEY: 'signkey-prod-test',
	},
}))

import { POST } from './route'

const runId = '01M0JJGST0C0JGBPF94WXWEGPT'
const context = { params: Promise.resolve({ runOperation: `${runId}:cancel` }) }

function request(headers: Record<string, string> = {}) {
	return new Request(`https://www.aihero.dev/v1/course-sync/poller-runs/${runId}:cancel`, {
		method: 'POST',
		headers,
	})
}

describe('course sync poller run cancellation route', () => {
	beforeEach(() => {
		fetchMock.mockReset()
	})

	it('cancels one Inngest run with the runtime signing key', async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

		const response = await POST(
			request({ Authorization: 'Bearer operator-token-for-tests-1' }),
			context,
		)

		expect(response.status).toBe(202)
		await expect(response.json()).resolves.toEqual({ cancelled: true, runId })
		expect(fetchMock).toHaveBeenCalledWith(
			`https://api.inngest.com/v2/runs/${runId}/cancel`,
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					Authorization: 'Bearer signkey-prod-test',
				}),
			}),
		)
	})

	it('rejects requests without the operator token', async () => {
		const response = await POST(request(), context)

		expect(response.status).toBe(401)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('rejects malformed run IDs before calling Inngest', async () => {
		const response = await POST(
			request({ Authorization: 'Bearer operator-token-for-tests-1' }),
			{ params: Promise.resolve({ runOperation: 'not-a-run:cancel' }) },
		)

		expect(response.status).toBe(400)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
