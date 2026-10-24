import { describe, expect, it, vi } from 'vitest'

import {
	MAX_STEP_ATTEMPTS,
	runWithDeadlockRetry,
} from './deadlock-retry.test-support'

const deadlock = () =>
	Object.assign(new Error('Failed query'), {
		cause: { errno: 1213, code: 'ER_LOCK_DEADLOCK' },
	})

describe('runWithDeadlockRetry', () => {
	it('retries after a deadlock and returns the next result', async () => {
		const fn = vi
			.fn<[], Promise<string>>()
			.mockRejectedValueOnce(deadlock())
			.mockResolvedValueOnce('ok')
		await expect(runWithDeadlockRetry(fn)).resolves.toBe('ok')
		expect(fn).toHaveBeenCalledTimes(2)
	})

	it('rethrows the deadlock after all attempts', async () => {
		const error = deadlock()
		const fn = vi.fn<[], Promise<string>>().mockRejectedValue(error)
		await expect(runWithDeadlockRetry(fn)).rejects.toBe(error)
		expect(MAX_STEP_ATTEMPTS).toBe(3)
		expect(fn).toHaveBeenCalledTimes(3)
	})

	it('does not retry a non-deadlock error', async () => {
		const error = new Error('boom')
		const fn = vi.fn<[], Promise<string>>().mockRejectedValue(error)
		await expect(runWithDeadlockRetry(fn)).rejects.toBe(error)
		expect(fn).toHaveBeenCalledTimes(1)
	})
})
