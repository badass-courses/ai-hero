import { describe, expect, it, vi } from 'vitest'
import { ConvertKitApiError } from '@coursebuilder/core/providers/convertkit'
import { withKitRateLimitRetry } from './kit-rate-limit-retry'

const kitError = (status: number, responseHeaders = {}) =>
	new ConvertKitApiError({
		message: 'synthetic failure',
		status,
		statusText: 'Error',
		bodySnippet: '',
		responseHeaders,
	})

describe('Kit rate-limit retry', () => {
	it('retries 429 with short jitter and logs each scheduled attempt', async () => {
		const work = vi
			.fn()
			.mockRejectedValueOnce(kitError(429))
			.mockRejectedValueOnce(kitError(429))
			.mockResolvedValue('subscribed')
		const sleep = vi.fn().mockResolvedValue(undefined)
		const onRetry = vi.fn().mockResolvedValue(undefined)
		await expect(
			withKitRateLimitRetry('subscribe', work, {
				sleep,
				onRetry,
				random: () => 0.5,
			}),
		).resolves.toBe('subscribed')
		expect(work).toHaveBeenCalledTimes(3)
		expect(sleep.mock.calls).toEqual([[1_250], [2_250]])
		expect(onRetry.mock.calls).toEqual(
			[2, 3].map((attempt, index) => [
				{
					operation: 'subscribe',
					attempt,
					status: 429,
					delayMs: index ? 2_250 : 1_250,
					delaySource: 'inline-backoff',
				},
			]),
		)
	})
	it('honors a short Retry-After and adds jitter', async () => {
		const work = vi
			.fn()
			.mockRejectedValueOnce(kitError(429, { 'retry-after': '1' }))
			.mockResolvedValue(true)
		const sleep = vi.fn().mockResolvedValue(undefined)
		await withKitRateLimitRetry('write-fields', work, {
			sleep,
			onRetry: vi.fn(),
			random: () => 1,
		})
		expect(sleep).toHaveBeenCalledWith(1_500)
	})
	it('immediately refuses a Retry-After outside the five-second budget', async () => {
		const work = vi
			.fn()
			.mockRejectedValue(kitError(429, { 'retry-after': '60' }))
		const sleep = vi.fn()
		const onExhausted = vi.fn()
		await expect(
			withKitRateLimitRetry('subscribe', work, {
				sleep,
				onRetry: vi.fn(),
				onExhausted,
			}),
		).rejects.toMatchObject({ status: 429 })
		expect(sleep).not.toHaveBeenCalled()
		expect(work).toHaveBeenCalledOnce()
		expect(onExhausted).toHaveBeenCalledWith({
			operation: 'subscribe',
			attempts: 1,
			status: 429,
			reason: 'budget-exceeded',
		})
	})
	it('shares the total delay budget across HTTP calls in a compound operation', async () => {
		const budget = { startedAt: Date.now(), waitedMs: 4_500 }
		const sleep = vi.fn()
		await expect(
			withKitRateLimitRetry('write', vi.fn().mockRejectedValue(kitError(429)), {
				budget,
				sleep,
				onRetry: vi.fn(),
			}),
		).rejects.toMatchObject({ status: 429 })
		expect(sleep).not.toHaveBeenCalled()
	})
	it.each([400, 401, 403, 404, 500])(
		'does not retry HTTP %s',
		async (status) => {
			const work = vi.fn().mockRejectedValue(kitError(status))
			const onRetry = vi.fn()
			await expect(
				withKitRateLimitRetry('write', work, { onRetry }),
			).rejects.toMatchObject({ status })
			expect(work).toHaveBeenCalledOnce()
			expect(onRetry).not.toHaveBeenCalled()
		},
	)
	it('bounds repeated refusals and logs exhaustion', async () => {
		const error = kitError(429)
		const work = vi.fn().mockRejectedValue(error)
		const onExhausted = vi.fn()
		await expect(
			withKitRateLimitRetry('write', work, {
				sleep: vi.fn(),
				onRetry: vi.fn(),
				onExhausted,
			}),
		).rejects.toBe(error)
		expect(work).toHaveBeenCalledTimes(3)
		expect(onExhausted).toHaveBeenCalledWith({
			operation: 'write',
			attempts: 3,
			status: 429,
			reason: 'attempts-exhausted',
		})
	})
})
