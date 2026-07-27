import { describe, expect, it } from 'vitest'

import {
	isContentCompleteSkillsWorkflowEmailResourceId,
	isTerminalSkillsWorkflowEmailResourceId,
	nextSkillsWorkflowEmailResourceId,
	SKILLS_WORKFLOW_EMAIL_RESOURCE_IDS,
	SKILLS_WORKFLOW_EMAIL_STEPS,
	SKILLS_WORKFLOW_KIT_SEQUENCE_IDS,
} from './skills-workflow-path'

describe('skills workflow path', () => {
	it('defines both eight-email paths with email-7 terminal', () => {
		expect(SKILLS_WORKFLOW_EMAIL_STEPS).toHaveLength(16)
		expect(new Set(SKILLS_WORKFLOW_EMAIL_RESOURCE_IDS).size).toBe(16)
		expect(new Set(SKILLS_WORKFLOW_KIT_SEQUENCE_IDS).size).toBe(16)
		expect(nextSkillsWorkflowEmailResourceId('ai-hero-skills-workflow.email-6')).toBe(
			'ai-hero-skills-workflow.email-7',
		)
		expect(
			nextSkillsWorkflowEmailResourceId(
				'ai-hero-skills-team-workflow.team-email-6',
			),
		).toBe('ai-hero-skills-team-workflow.team-email-7')
		expect(nextSkillsWorkflowEmailResourceId('ai-hero-skills-workflow.email-7')).toBeUndefined()
	})

	it('keeps content completion on email-6 while terminal moves to email-7', () => {
		expect(
			isContentCompleteSkillsWorkflowEmailResourceId(
				'ai-hero-skills-workflow.email-6',
			),
		).toBe(true)
		expect(
			isTerminalSkillsWorkflowEmailResourceId(
				'ai-hero-skills-workflow.email-6',
			),
		).toBe(false)
		expect(
			isTerminalSkillsWorkflowEmailResourceId(
				'ai-hero-skills-workflow.email-7',
			),
		).toBe(true)
	})
})
