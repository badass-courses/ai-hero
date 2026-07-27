import { describe, expect, it } from 'vitest'

import {
	classifyLearnerFlowContact,
	isCourseValuePathIntent,
} from './learner-flow-classifier'
import type { SideEffectIntent } from './types'

const now = '2026-07-15T12:00:00.000Z'

function intent(
	overrides: Partial<SideEffectIntent> & {
		metadata?: Record<string, unknown>
	} = {},
): SideEffectIntent {
	const { metadata, ...fields } = overrides
	return {
		id: 'intent-1',
		nextActionId: 'action-1',
		contactId: 'contact-1',
		provider: 'kit',
		type: 'send-value-path-email',
		status: 'pending',
		idempotencyKey: 'key-1',
		gates: [],
		reviewReasons: [],
		createdAt: '2026-07-15T11:00:00.000Z',
		...fields,
		metadata: {
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-0',
			...metadata,
		},
	}
}

function classify(
	args: Omit<Parameters<typeof classifyLearnerFlowContact>[0], 'now'>,
) {
	return classifyLearnerFlowContact({ ...args, now })
}

describe('learner-flow classifier', () => {
	it('keeps fresh pending work moving', () => {
		expect(
			classify({ contactId: 'contact-1', intents: [intent()] }),
		).toMatchObject({ state: 'moving', stage: 'ai-hero-skills-workflow.email-0' })
	})

	it('includes legacy path intents that only carry the email resource id', () => {
		const result = classify({
			contactId: 'contact-1',
			intents: [
				intent({
					metadata: {
						valuePathSlug: undefined,
						emailResourceId: 'ai-hero-skills-workflow.email-0',
					},
				}),
			],
		})
		expect(result).toMatchObject({ state: 'moving' })
	})

	it('does not mistake a similarly named path for the approved course path', () => {
		expect(
			isCourseValuePathIntent(
				intent({
					metadata: {
						valuePathSlug: undefined,
						emailResourceId: 'ai-hero-skills-workflow-old.email-0',
					},
				}),
			),
		).toBe(false)
	})

	it('moves terminal to email-7 while email-6 remains content-complete', () => {
		const email6 = intent({
			status: 'completed',
			metadata: {
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-6',
				completedAt: '2026-07-14T11:00:00.000Z',
			},
		})
		const email7 = intent({
			status: 'completed',
			metadata: {
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-7',
				completedAt: '2026-07-15T11:00:00.000Z',
			},
		})
		expect(classify({ contactId: 'contact-1', intents: [email6] })).toMatchObject(
			{ state: 'stuck', cause: 'drip-starved' },
		)
		expect(classify({ contactId: 'contact-1', intents: [email7] })).toMatchObject(
			{ state: 'terminal' },
		)
	})

	it.each([
		['blocked-intent', intent({ status: 'blocked' })],
		[
			'failed-send',
			intent({ status: 'failed', metadata: { retryable: false } }),
		],
		[
			'retryable-failed-overdue',
			intent({
				status: 'failed',
				metadata: {
					retryable: true,
					nextRetryAt: '2026-07-15T11:00:00.000Z',
				},
			}),
		],
		['bounced', intent({ status: 'blocked', reviewReasons: ['bounced'] })],
		[
			'complained',
			intent({ status: 'blocked', reviewReasons: ['complained'] }),
		],
		[
			'unsubscribed',
			intent({ status: 'blocked', reviewReasons: ['unsubscribed'] }),
		],
	] as const)('reports %s as a visible stuck cause', (cause, fixture) => {
		const result = classify({ contactId: 'contact-1', intents: [fixture] })
		expect(result).toMatchObject({ state: 'stuck', cause })
		expect(result.unstickCommand).toBeTruthy()
	})

	it('keeps a progressing contact moving despite the human-review companion', () => {
		const result = classify({
			contactId: 'contact-1',
			contactState: { humanReview: true, lifecycle: 'human-review' },
			intents: [
				intent({
					id: 'email-0',
					status: 'completed',
					metadata: { completedAt: '2026-07-15T10:00:00.000Z' },
				}),
				intent({
					id: 'email-1',
					createdAt: '2026-07-15T11:00:00.000Z',
					metadata: { emailResourceId: 'ai-hero-skills-workflow.email-1' },
				}),
				intent({
					id: 'review-companion',
					provider: 'dry-run',
					type: 'human-review',
					status: 'blocked',
				}),
			],
		})
		expect(result).toMatchObject({
			state: 'moving',
			stage: 'ai-hero-skills-workflow.email-1',
		})
	})

	it('parks human review only after course progression stalls', () => {
		const result = classify({
			contactId: 'contact-1',
			contactState: { humanReview: true, lifecycle: 'human-review' },
			intents: [intent({ createdAt: '2026-07-12T11:00:00.000Z' })],
		})
		expect(result).toMatchObject({
			state: 'stuck',
			cause: 'human-review-parked',
			unstickCommand: 'tier-2: ask Joel (human-review-parked; contact contact-1)',
		})
	})

	it('catches a missing next email after the cadence window as drip-starved', () => {
		const result = classify({
			contactId: 'contact-1',
			intents: [
				intent({
					status: 'completed',
					metadata: {
						valuePathSlug: 'ai-hero-skills-workflow',
						emailResourceId: 'ai-hero-skills-workflow.email-0',
						completedAt: '2026-07-12T11:00:00.000Z',
					},
				}),
			],
		})
		expect(result).toMatchObject({
			state: 'stuck',
			cause: 'drip-starved',
			stuckAgeHours: 73,
		})
	})

	it('never silently drops an unclassifiable stale course intent', () => {
		const result = classify({
			contactId: 'contact-1',
			intents: [
				intent({
					status: 'pending',
					createdAt: '2026-07-12T11:00:00.000Z',
				}),
			],
		})
		expect(result).toMatchObject({ state: 'stuck', cause: 'classifier-gap' })
	})
})
