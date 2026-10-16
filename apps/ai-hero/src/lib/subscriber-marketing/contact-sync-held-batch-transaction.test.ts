import { describe, expect, it, vi } from 'vitest'
import { retryHeldBatchTransaction } from './contact-sync-held-batch-transaction'

describe('bounded pin transaction contention', () => {
	it('retries only a rolled-back deadlock and returns the committed result', async () => {
		const run = vi
			.fn()
			.mockRejectedValueOnce({ errno: 1213 })
			.mockRejectedValueOnce({ cause: { code: 'ER_LOCK_DEADLOCK' } })
			.mockResolvedValue('synthetic-committed')
		await expect(retryHeldBatchTransaction(run)).resolves.toBe(
			'synthetic-committed',
		)
		expect(run).toHaveBeenCalledTimes(3)
	})
	it('has a hard three-transaction bound, never an automatic unbounded requeue', async () => {
		const run = vi.fn().mockRejectedValue({ cause: { errno: 1213 } })
		await expect(retryHeldBatchTransaction(run)).rejects.toThrow(
			/bounded transaction contention/,
		)
		expect(run).toHaveBeenCalledTimes(3)
	})
	it.each([
		{ errno: 1146 },
		{ status: 503 },
		new Error('synthetic storage failure'),
	])(
		'does not retry non-deadlock failures or broker/HTTP outcomes',
		async (error) => {
			const run = vi.fn().mockRejectedValue(error)
			await expect(retryHeldBatchTransaction(run)).rejects.toBe(error)
			expect(run).toHaveBeenCalledOnce()
		},
	)
})
