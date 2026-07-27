import { describe, expect, it } from 'vitest'

import {
	EMAIL_7_COPY_APPROVAL_REVIEW_REASON,
	evaluateEmail7LaunchGate,
	parseEmail7LiveEnabled,
} from './email-7-launch-gate'

describe('email-7 launch gate', () => {
	it('defaults closed for real learners and opens only by explicit true', () => {
		expect(parseEmail7LiveEnabled(undefined)).toBe(false)
		expect(parseEmail7LiveEnabled('false')).toBe(false)
		expect(parseEmail7LiveEnabled('true')).toBe(true)
		expect(
			evaluateEmail7LaunchGate({
				emailResourceId: 'ai-hero-skills-workflow.email-7',
				email: 'learner@example.com',
			}),
		).toMatchObject({
			passed: false,
			reviewReasons: [EMAIL_7_COPY_APPROVAL_REVIEW_REASON],
		})
	})

	it('lets only the canary prove email-7 while the real gate is closed', () => {
		expect(
			evaluateEmail7LaunchGate({
				emailResourceId: 'ai-hero-skills-workflow.email-7',
				email: 'joel+aih-synth-canary-learner-v1-generation-1@badass.dev',
			}),
		).toMatchObject({ passed: true, canaryBypass: true })
		expect(
			evaluateEmail7LaunchGate({
				emailResourceId: 'ai-hero-skills-workflow.email-6',
				email: 'learner@example.com',
			}),
		).toMatchObject({ passed: true, applies: false })
	})
})
