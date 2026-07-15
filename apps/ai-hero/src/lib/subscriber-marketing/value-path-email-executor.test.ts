import { describe, expect, it, vi } from 'vitest'

import { executePendingValuePathEmailIntents } from './value-path-email-executor'

describe('value path email executor', () => {
	it('passes an explicit intent scope to the repository', async () => {
		const findPendingValuePathEmailSideEffectIntents = vi
			.fn()
			.mockResolvedValue([])
		await executePendingValuePathEmailIntents({
			repository: {
				findPendingValuePathEmailSideEffectIntents,
				findContactById: vi.fn(),
				findCurrentContactState: vi.fn(),
				updateSideEffectIntent: vi.fn(),
			},
			emailListProvider: { subscribeToList: vi.fn() },
			config: { limit: 3, intentIds: ['intent-1', 'intent-2'] },
		})
		expect(findPendingValuePathEmailSideEffectIntents).toHaveBeenCalledWith({
			limit: 3,
			intentIds: ['intent-1', 'intent-2'],
		})
	})

	it('keeps an explicit empty scope distinct from an unscoped queue', async () => {
		const findPendingValuePathEmailSideEffectIntents = vi
			.fn()
			.mockResolvedValue([])
		await executePendingValuePathEmailIntents({
			repository: {
				findPendingValuePathEmailSideEffectIntents,
				findContactById: vi.fn(),
				findCurrentContactState: vi.fn(),
				updateSideEffectIntent: vi.fn(),
			},
			emailListProvider: { subscribeToList: vi.fn() },
			config: { intentIds: [] },
		})
		expect(findPendingValuePathEmailSideEffectIntents).toHaveBeenCalledWith({
			limit: 25,
			intentIds: [],
		})
	})
})
