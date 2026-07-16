import { describe, expect, it, vi } from 'vitest'

import {
	fetchKitSignupGapPageWithRetry,
	SignupGapSourceUnavailableError,
} from './signup-gap-recovery'

describe('signup-gap Kit source resilience', () => {
	it('retries Kit HTTP 500s three times with exponential backoff', async () => {
		const request = vi
			.fn<[number], Promise<Response>>()
			.mockResolvedValueOnce(new Response('{}', { status: 500 }))
			.mockResolvedValueOnce(new Response('{}', { status: 502 }))
			.mockResolvedValueOnce(new Response('{}', { status: 200 }))
		const sleep = vi.fn<[number], Promise<void>>()
			.mockResolvedValue(undefined)

		const response = await fetchKitSignupGapPageWithRetry({
			request,
			backoffMs: 10,
			sleep,
		})

		expect(response.status).toBe(200)
		expect(request).toHaveBeenCalledTimes(3)
		expect(request.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 3])
		expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
			10,
			20,
		])
	})

	it('reports a typed source-unavailable error after the third Kit 500', async () => {
		const request = vi.fn(async () => new Response('{}', { status: 500 }))

		await expect(
			fetchKitSignupGapPageWithRetry({
				request,
				backoffMs: 0,
				sleep: async () => undefined,
			}),
		).rejects.toEqual(
			expect.objectContaining<Partial<SignupGapSourceUnavailableError>>({
				name: 'SignupGapSourceUnavailableError',
				attempts: 3,
				statusCode: 500,
			}),
		)
		expect(request).toHaveBeenCalledTimes(3)
	})
})
