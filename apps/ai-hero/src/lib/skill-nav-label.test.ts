import { describe, expect, it } from 'vitest'

import { skillNavLabel } from './skill-nav-label'

describe('skillNavLabel', () => {
	it('unwraps the "The <name> Skill" frame', () => {
		expect(skillNavLabel('The /grill-me Skill')).toBe('/grill-me')
		expect(skillNavLabel('The /to-questionnaire Skill')).toBe(
			'/to-questionnaire',
		)
		expect(skillNavLabel('The /improve-codebase-architecture Skill')).toBe(
			'/improve-codebase-architecture',
		)
	})

	it('keeps a title that is not framed that way', () => {
		expect(skillNavLabel('Overview')).toBe('Overview')
		expect(skillNavLabel('Getting Started')).toBe('Getting Started')
		expect(skillNavLabel('Skills for real engineers')).toBe(
			'Skills for real engineers',
		)
	})

	it('does not eat a title that is only the frame', () => {
		// "The Skill" has no name inside it, so there is nothing to unwrap and
		// blanking the row would be worse than leaving it long.
		expect(skillNavLabel('The Skill')).toBe('The Skill')
	})

	it('matches the frame regardless of case and surrounding space', () => {
		expect(skillNavLabel('  The /wizard skill  ')).toBe('/wizard')
	})

	it('leaves a title that merely contains the words alone', () => {
		expect(skillNavLabel('The Skill That Ate My Backlog, Explained')).toBe(
			'The Skill That Ate My Backlog, Explained',
		)
		expect(skillNavLabel('Why The /triage Skill Works')).toBe(
			'Why The /triage Skill Works',
		)
	})
})
