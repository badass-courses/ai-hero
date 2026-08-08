import { describe, expect, it, vi } from 'vitest'

import { ConvertKitApiError } from '@coursebuilder/core/providers/convertkit'

import {
	KIT_WRITE_BASE_DELAY_MS,
	retryKitWrite,
} from './kit-write-retry'

function kitError(status: number, responseHeaders: Record<string, string> = {}) {
	return new ConvertKitApiError({
		message: `Kit failed with ${status}`,
		status,
		statusText: 'Error',
		bodySnippet: '',
		responseHeaders,
	})
}

describe('retryKitWrite', () => {
	it.each([429, 500, 503])(
		'retries Kit HTTP %s responses with exponential backoff',
		async (status) => {
			const write = vi
				.fn()
				.mockRejectedValueOnce(kitError(status))
				.mockRejectedValueOnce(kitError(status))
				.mockResolvedValue({ id: 42 })
			const sleep = vi.fn().mockResolvedValue(undefined)
			const onRetry = vi.fn()

			await expect(retryKitWrite({ write, sleep, onRetry })).resolves.toEqual({
				id: 42,
			})
			expect(write).toHaveBeenCalledTimes(3)
			expect(sleep).toHaveBeenNthCalledWith(1, KIT_WRITE_BASE_DELAY_MS)
			expect(sleep).toHaveBeenNthCalledWith(2, KIT_WRITE_BASE_DELAY_MS * 2)
			expect(onRetry).toHaveBeenNthCalledWith(1, {
				attempt: 1,
				status,
				delayMs: KIT_WRITE_BASE_DELAY_MS,
			})
		})

	it('honors a bounded Retry-After header', async () => {
		const write = vi
			.fn()
			.mockRejectedValueOnce(kitError(429, { 'retry-after': '10' }))
			.mockResolvedValue('ok')
		const sleep = vi.fn().mockResolvedValue(undefined)

		await retryKitWrite({ write, sleep })

		expect(sleep).toHaveBeenCalledWith(2_000)
	})

	it('does not retry non-retryable Kit responses', async () => {
		const error = kitError(400)
		const write = vi.fn().mockRejectedValue(error)
		const sleep = vi.fn()

		await expect(retryKitWrite({ write, sleep })).rejects.toBe(error)
		expect(write).toHaveBeenCalledTimes(1)
		expect(sleep).not.toHaveBeenCalled()
	})

	it('rethrows after the third retryable failure', async () => {
		const error = kitError(429)
		const write = vi.fn().mockRejectedValue(error)
		const sleep = vi.fn().mockResolvedValue(undefined)

		await expect(retryKitWrite({ write, sleep })).rejects.toBe(error)
		expect(write).toHaveBeenCalledTimes(3)
		expect(sleep).toHaveBeenCalledTimes(2)
	})
})
