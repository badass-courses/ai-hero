import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('@/server/logger', () => ({ log: { error: mocks.error } }))
import { withInngestFailureLogging } from './serve-failure-logging'
const request = {
	url: 'https://example.invalid/api/inngest?fnId=app-function-v1&stepId=step_fixture',
}
describe('Inngest serve failure logs', () => {
	beforeEach(() => {
		mocks.error.mockReset()
	})
	it.each([200, 500, 503])(
		'passes status %s through with identical body, headers and response identity',
		async (status) => {
			const response = new Response('unchanged body', {
				status,
				headers: { 'x-inngest': 'fixture' },
			})
			const handler = vi.fn(async () => response)
			const output = await withInngestFailureLogging(handler)(request)
			expect(output).toBe(response)
			expect(output.status).toBe(status)
			expect(output.headers.get('x-inngest')).toBe('fixture')
			expect(await output.text()).toBe('unchanged body')
			if (status === 200) expect(mocks.error).not.toHaveBeenCalled()
			else {
				expect(mocks.error).toHaveBeenCalledOnce()
				expect(mocks.error).toHaveBeenCalledWith('inngest.serve.failed', {
					fnId: 'app-function-v1',
					stepId: 'step_fixture',
					status,
					errorClass: 'InngestServeResponseError',
					message: 'Inngest serve request failed',
				})
			}
		},
	)
	it('rethrows the same error and never logs its private message', async () => {
		const error = new TypeError('private provider detail')
		const handler = async () => {
			throw error
		}
		await expect(withInngestFailureLogging(handler)(request)).rejects.toBe(
			error,
		)
		expect(mocks.error).toHaveBeenCalledOnce()
		expect(mocks.error).toHaveBeenCalledWith(
			'inngest.serve.failed',
			expect.objectContaining({ errorClass: 'TypeError', status: 500 }),
		)
		expect(JSON.stringify(mocks.error.mock.calls)).not.toContain(
			'private provider detail',
		)
	})
	it('cannot replace an HTTP response or throw when logging fails', async () => {
		mocks.error.mockRejectedValue(new Error('logger unavailable'))
		const response = new Response('same', { status: 500 })
		expect(await withInngestFailureLogging(async () => response)(request)).toBe(
			response,
		)
		const error = { synthetic: true }
		await expect(
			withInngestFailureLogging(async () => {
				throw error
			})(request),
		).rejects.toBe(error)
	})
	it('rejects arbitrary query strings as ids and does not log payloads', async () => {
		await withInngestFailureLogging(
			async () => new Response('', { status: 500 }),
		)({
			url: 'https://example.invalid/?fnId=someone%40example.invalid&payload=secret',
		})
		expect(mocks.error).toHaveBeenCalledWith(
			'inngest.serve.failed',
			expect.objectContaining({ fnId: null, stepId: null }),
		)
		expect(JSON.stringify(mocks.error.mock.calls)).not.toMatch(
			/someone|payload|secret/,
		)
	})
})
