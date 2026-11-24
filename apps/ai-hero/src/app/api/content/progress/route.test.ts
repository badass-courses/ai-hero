import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { POST } from './route'

const { captureContentProgress, logError } = vi.hoisted(() => ({
	captureContentProgress: vi.fn(),
	logError: vi.fn(),
}))

vi.mock('@/lib/content-progress', () => ({ captureContentProgress }))
vi.mock('@/server/logger', () => ({ log: { error: logError } }))

function request(body?: BodyInit) {
	return new NextRequest('https://example.test/api/content/progress', {
		method: 'POST',
		body,
	})
}

describe('POST /api/content/progress', () => {
	beforeEach(() => vi.resetAllMocks())

	it.each([undefined, '', '{'])('rejects unreadable JSON (%s) as 400', async (body) => {
		const response = await POST(request(body))

		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({
			ok: false,
			error: 'Invalid content progress payload',
		})
		expect(captureContentProgress).not.toHaveBeenCalled()
		expect(logError).not.toHaveBeenCalled()
	})

	it('returns 400 when reading the request body aborts', async () => {
		const req = request()
		vi.spyOn(req, 'json').mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'))

		expect((await POST(req)).status).toBe(400)
		expect(captureContentProgress).not.toHaveBeenCalled()
		expect(logError).not.toHaveBeenCalled()
	})

	it('still sends parsed JSON to capture and returns 201 for a capture', async () => {
		const payload = { resourceId: 'lesson_example' }
		captureContentProgress.mockResolvedValue({ status: 'captured' })

		const response = await POST(request(JSON.stringify(payload)))

		expect(captureContentProgress).toHaveBeenCalledWith(payload)
		expect(response.status).toBe(201)
		expect(await response.json()).toEqual({ ok: true })
	})

	it('still treats capture failures as server errors', async () => {
		captureContentProgress.mockRejectedValue(new Error('database unavailable'))

		expect((await POST(request('{}'))).status).toBe(500)
		expect(logError).toHaveBeenCalledWith('api.content.progress.failed', {
			error: 'database unavailable',
		})
	})
})
