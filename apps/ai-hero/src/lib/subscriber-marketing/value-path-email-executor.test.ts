import { describe, expect, it, vi } from 'vitest'

import type { SideEffectIntent } from './types'
import {
	buildValuePathEmailPersonalization,
	executePendingValuePathEmailIntents,
	executeValuePathEmailIntent,
} from './value-path-email-executor'

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

	it('refuses to resend when the canonical completion fact beats a stale pending status', async () => {
		const subscribeToList = vi.fn()
		const result = await executeValuePathEmailIntent({
			repository: {
				findPendingValuePathEmailSideEffectIntents: vi.fn(),
				findContactById: vi.fn(),
				findCurrentContactState: vi.fn(),
				updateSideEffectIntent: vi.fn(),
			},
			emailListProvider: { subscribeToList },
			intent: valuePathIntent({
				status: 'pending',
				completedAt: '2026-07-17T12:00:00.000Z',
			}),
		})
		expect(result).toEqual({
			status: 'skipped',
			intentId: 'intent-1',
			reviewReasons: ['intent-already-completed'],
		})
		expect(subscribeToList).not.toHaveBeenCalled()
	})

	it('stamps course completion and the certificate URL into email-7 personalization', () => {
		const now = '2026-07-18T12:00:00.000Z'
		const result = buildValuePathEmailPersonalization({
			contactId: 'contact-1',
			kitSubscriberId: 'kit-1',
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-7',
			baseUrl: 'https://www.aihero.dev',
			pathTokenSecret: 'test-secret',
			now,
			answerPages: [
				{
					id: 'answer-7-a',
					type: 'value-path-page',
					fields: {
						kind: 'answer',
						slug: 'email-7-placeholder-a',
						sequenceId: 'ai-hero-skills-workflow',
						emailId: 'email-7',
						optionValue: 'placeholder-option-a',
					},
				},
			],
		})
		expect(result).toMatchObject({
			passed: true,
			fields: {
				aih_course_completed_at: now,
				aih_value_path_certificate_url:
					'https://www.aihero.dev/api/certificates?resource=value-path%3Aai-hero-skills-workflow&user=contact-1',
			},
		})
	})

	it('blocks a real email-7 send until copy approval explicitly opens the gate', async () => {
		const updateSideEffectIntent = vi.fn()
		const subscribeToList = vi.fn()
		const intent = valuePathIntent({
			metadata: {
				mode: 'scoped-live',
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-7',
				kitSequenceId: '2831545',
				kitSubscriberId: 'kit-1',
			},
		})
		const result = await executeValuePathEmailIntent({
			repository: {
				findPendingValuePathEmailSideEffectIntents: vi.fn(),
				findContactById: vi.fn().mockResolvedValue({
					id: 'contact-1',
					email: 'learner@example.com',
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
			intent,
			config: {
				mode: 'scoped-live',
				allowlistedContactIds: ['contact-1'],
				allowlistedKitSubscriberIds: ['kit-1'],
				allowlistedEmails: ['learner@example.com'],
				enabledValuePathSlugs: ['ai-hero-skills-workflow'],
				verifiedEmailResourceIds: ['ai-hero-skills-workflow.email-7'],
				verifiedKitSequenceIds: ['2831545'],
				allowedActions: ['send-path-emails'],
			},
		})
		expect(result).toMatchObject({
			status: 'blocked',
			reviewReasons: ['email-7-copy-approval-required'],
		})
		expect(subscribeToList).not.toHaveBeenCalled()
		expect(updateSideEffectIntent).toHaveBeenCalledWith(
			'intent-1',
			expect.objectContaining({ status: 'blocked' }),
		)
	})

	it('writes canonical and rollback stamps in the same completion update', async () => {
		const updateSideEffectIntent = vi.fn()
		const completedAt = '2026-07-17T12:00:00.000Z'
		const result = await executeValuePathEmailIntent({
			repository: {
				findPendingValuePathEmailSideEffectIntents: vi.fn(),
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
			emailListProvider: {
				subscribeToList: vi.fn().mockResolvedValue({ subscriptionId: 'kit-1' }),
			},
			intent: valuePathIntent(),
			now: completedAt,
			config: {
				mode: 'scoped-live',
				allowWrite: true,
				allowlistedContactIds: ['contact-1'],
				allowlistedKitSubscriberIds: ['kit-1'],
				allowlistedEmails: ['learner@example.com'],
				enabledValuePathSlugs: ['ai-hero-skills-workflow'],
				verifiedEmailResourceIds: ['ai-hero-skills-workflow.email-6'],
				verifiedKitSequenceIds: ['2757205'],
				allowedActions: ['send-path-emails'],
			},
		})
		expect(result.status).toBe('completed')
		expect(updateSideEffectIntent).toHaveBeenCalledWith(
			'intent-1',
			expect.objectContaining({
				status: 'completed',
				completedAt,
				metadata: expect.objectContaining({ completedAt }),
			}),
		)
	})
})

function valuePathIntent(
	overrides: Partial<SideEffectIntent> = {},
): SideEffectIntent {
	return {
		id: 'intent-1',
		nextActionId: 'next-action-1',
		contactId: 'contact-1',
		provider: 'kit',
		type: 'send-value-path-email',
		status: 'pending',
		idempotencyKey: 'intent-key-1',
		gates: [],
		reviewReasons: [],
		metadata: {
			mode: 'scoped-live',
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-6',
			kitSequenceId: '2757205',
			kitSubscriberId: 'kit-1',
		},
		createdAt: '2026-07-17T11:00:00.000Z',
		...overrides,
	}
}
