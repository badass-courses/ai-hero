import { describe, expect, it, vi } from 'vitest'

import {
	isTransientDatabaseReadError,
	retryTransientDatabaseRead,
} from './transient-database-read'

describe('isTransientDatabaseReadError', () => {
	it('recognizes database 5xx responses', () => {
		expect(isTransientDatabaseReadError({ status: 503 })).toBe(true)
		expect(
			isTransientDatabaseReadError(new Error('Service Unavailable')),
		).toBe(true)
	})

	it('does not retry ordinary application errors', () => {
		expect(isTransientDatabaseReadError(new Error('bad input'))).toBe(false)
	})
})

describe('retryTransientDatabaseRead', () => {
	it('retries a transient failure with exponential delays', async () => {
		const operation = vi
			.fn(async (): Promise<string> => 'ok')
			.mockRejectedValueOnce({ status: 503 })
			.mockRejectedValueOnce({ status: 500 })
			.mockResolvedValue('ok')
		const sleep = vi.fn(async () => undefined)

		await expect(
			retryTransientDatabaseRead(operation, {
				attempts: 4,
				baseDelayMs: 100,
				sleep,
			}),
		).resolves.toBe('ok')
		expect(sleep).toHaveBeenNthCalledWith(1, 100)
		expect(sleep).toHaveBeenNthCalledWith(2, 200)
	})

	it('fails immediately for a non-transient error', async () => {
		const error = new Error('bad input')
		const operation = vi.fn(async () => {
			throw error
		})
		const sleep = vi.fn(async () => undefined)

		await expect(
			retryTransientDatabaseRead(operation, { sleep }),
		).rejects.toBe(error)
		expect(sleep).not.toHaveBeenCalled()
	})
})
