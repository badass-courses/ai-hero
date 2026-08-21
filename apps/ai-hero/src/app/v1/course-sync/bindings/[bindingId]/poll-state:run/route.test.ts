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
		fetchMock.mockReset()
	})

	it('directly invokes one idempotent course-sync poll', async () => {
		fetchMock.mockResolvedValue(
			Response.json({ data: { id: '01M0JJGST0C0JGBPF94WXWEGPT' } }),
		)

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
			runId: '01M0JJGST0C0JGBPF94WXWEGPT',
			invocationKey: expect.stringMatching(/^course-sync-poll:[a-f0-9]{64}$/),
		})
		expect(fetchMock).toHaveBeenCalledWith(
			'https://api.inngest.com/v2/apps/ai-hero/functions/ai-hero-ai-hero-course-sync-detection-poller/invoke',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					Authorization: 'Bearer signkey-prod-test',
				}),
				body: expect.stringContaining('operator-requested-run-now'),
			}),
		)
	})

	it('rejects requests without the operator token', async () => {
		const response = await POST(
			request({ 'idempotency-key': 'unauthorized' }),
			context,
		)

		expect(response.status).toBe(401)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
