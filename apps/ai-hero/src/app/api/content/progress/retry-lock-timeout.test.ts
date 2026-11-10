import { describe, expect, it, vi } from 'vitest'

import { isLockWaitTimeout, retryOnceOnLockTimeout } from './retry-lock-timeout'

const lockError = () => Object.assign(new Error('boom'), { errno: 1205 })

describe('retryOnceOnLockTimeout', () => {
	it('returns success after one 1205 then success', async () => {
		const op = vi
			.fn()
			.mockRejectedValueOnce(lockError())
			.mockResolvedValueOnce({ status: 'captured' })
		await expect(retryOnceOnLockTimeout(op)).resolves.toEqual({
			status: 'captured',
		})
		expect(op).toHaveBeenCalledTimes(2)
	})

	it('surfaces the error after two 1205s', async () => {
		const op = vi.fn().mockRejectedValue(lockError())
		await expect(retryOnceOnLockTimeout(op)).rejects.toMatchObject({
			errno: 1205,
		})
		expect(op).toHaveBeenCalledTimes(2)
	})

	it('treats a duplicate-key outcome on retry as success', async () => {
		const op = vi
			.fn()
			.mockRejectedValueOnce(lockError())
			.mockResolvedValueOnce({ status: 'deduped' })
		await expect(retryOnceOnLockTimeout(op)).resolves.toEqual({
			status: 'deduped',
		})
	})

	it('does not retry other errors', async () => {
		const op = vi.fn().mockRejectedValue(new Error('other'))
		await expect(retryOnceOnLockTimeout(op)).rejects.toThrow('other')
		expect(op).toHaveBeenCalledTimes(1)
	})

	it('detects errno on a wrapped cause', () => {
		expect(isLockWaitTimeout(new Error('x', { cause: lockError() }))).toBe(true)
		expect(isLockWaitTimeout(new Error('x'))).toBe(false)
	})
})
