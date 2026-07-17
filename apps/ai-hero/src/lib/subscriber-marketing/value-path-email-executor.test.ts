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

	it('runs the real retry planner in no-write mode without touching Kit or the intent', async () => {
		const intent = {
			id: 'retry-intent-1',
			nextActionId: 'next-action-1',
			contactId: 'contact-1',
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'failed',
			idempotencyKey: 'retry-intent-key',
			gates: [],
			reviewReasons: ['kit-sequence-enrollment-retryable'],
			metadata: {
				mode: 'scoped-live',
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-6',
				kitSequenceId: '2757205',
				kitSubscriberId: 'kit-1',
				retryable: true,
				nextRetryAt: '2026-07-17T11:00:00.000Z',
			},
			createdAt: '2026-07-17T10:00:00.000Z',
		} as const
		const updateSideEffectIntent = vi.fn()
		const subscribeToList = vi.fn()

		const result = await executePendingValuePathEmailIntents({
			repository: {
				findPendingValuePathEmailSideEffectIntents: vi
					.fn()
					.mockResolvedValue([intent]),
				findContactById: vi.fn().mockResolvedValue({
					id: 'contact-1',
					email: 'learner@example.com',
					name: 'Learner',
				}),
				findCurrentContactState: vi.fn().mockResolvedValue({
					id: 'state-1',
					contactId: 'contact-1',
					lifecycle: 'nurture-ready',
					reviewSignals: [],
					humanReview: false,
				}),
				updateSideEffectIntent,
			},
			emailListProvider: { subscribeToList },
			now: '2026-07-17T12:00:00.000Z',
			config: {
				allowWrite: false,
				mode: 'scoped-live',
				intentIds: ['retry-intent-1'],
				allowlistedContactIds: ['contact-1'],
				allowlistedKitSubscriberIds: ['kit-1'],
				allowlistedEmails: ['learner@example.com'],
				enabledValuePathSlugs: ['ai-hero-skills-workflow'],
				verifiedEmailResourceIds: ['ai-hero-skills-workflow.email-6'],
				verifiedKitSequenceIds: ['2757205'],
				allowedActions: [
					'retry-transient-provider-failures',
					'send-path-emails',
				],
			},
		})

		expect(result).toEqual([
			{
				status: 'planned',
				intentId: 'retry-intent-1',
				kitSequenceId: '2757205',
				email: 'learner@example.com',
			},
		])
		expect(subscribeToList).not.toHaveBeenCalled()
		expect(updateSideEffectIntent).not.toHaveBeenCalled()
	})
})
