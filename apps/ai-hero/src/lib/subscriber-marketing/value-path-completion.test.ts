import { describe, expect, it } from 'vitest'

import { classifyLearnerFlowContact } from './learner-flow-classifier'
import type { SideEffectIntent } from './types'
import { valuePathIntentCompletedAt } from './value-path-completion'
import { isLocalDayDripDue } from './value-path-drip-progression'
import { scanCompletedValuePathIntentFrontier } from './value-path-intent-scan'

function intent(shape: 'old' | 'new'): SideEffectIntent {
	const completedAt = '2026-07-14T09:00:00.000Z'
	return {
		id: 'intent-1',
		nextActionId: 'next-action',
		contactId: 'contact-1',
		provider: 'kit',
		type: 'send-value-path-email',
		// The new canonical fact wins even if the old status field drifts.
		status: shape === 'old' ? 'completed' : 'pending',
		completedAt: shape === 'new' ? completedAt : undefined,
		idempotencyKey: 'intent-1-key',
		gates: [],
		reviewReasons: [],
		metadata: {
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-0',
			kitSequenceId: '2757199',
			...(shape === 'old' ? { completedAt } : {}),
		},
		createdAt: '2026-07-14T08:59:00.000Z',
	}
}

describe('single-truth value-path completion fact', () => {
	it('classifies and plans old-shape and new-shape intents identically', () => {
		const oldShape = intent('old')
		const newShape = intent('new')
		const now = '2026-07-17T12:00:00.000Z'

		const classify = (candidate: SideEffectIntent) =>
			classifyLearnerFlowContact({
				contactId: candidate.contactId,
				intents: [candidate],
				now,
			})
		expect(classify(oldShape)).toEqual(classify(newShape))
		expect(classify(newShape)).toMatchObject({
			state: 'stuck',
			cause: 'drip-starved',
		})

		const plan = (candidate: SideEffectIntent) => {
			const scan = scanCompletedValuePathIntentFrontier({
				intents: [candidate],
				limit: 1,
				now,
			})
			return {
				planned: scan.intents.length,
				due: isLocalDayDripDue({
					completedAt: valuePathIntentCompletedAt(candidate),
					now,
				}),
			}
		}
		expect(plan(oldShape)).toEqual(plan(newShape))
		expect(plan(newShape)).toMatchObject({ planned: 1, due: { due: true } })
	})
})
