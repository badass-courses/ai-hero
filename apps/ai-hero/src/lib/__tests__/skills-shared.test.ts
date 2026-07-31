import {
	isSkillPhaseTag,
	SKILL_PHASE_UTILITY_NUMBER,
	skillPhaseFromTag,
} from '@/lib/skills-shared'
import { type Tag } from '@/lib/tags'
import { describe, expect, it } from 'vitest'

/** A tag shaped like the hand-created skill-phase tags on production. */
function phaseTag(fields: Partial<Tag['fields']> = {}): Tag {
	return {
		id: 'tag_1',
		type: 'topic',
		fields: {
			name: 'phase-1',
			label: 'Phase 1: Idea',
			slug: 'phase-1',
			description: null,
			image: null,
			contexts: ['skill-phase'],
			url: null,
			popularity_order: null,
			...fields,
		},
		createdAt: new Date(),
		updatedAt: new Date(),
	} as Tag
}

describe('isSkillPhaseTag', () => {
	it('is true only when the skill-phase context is present', () => {
		expect(isSkillPhaseTag(phaseTag())).toBe(true)
		expect(isSkillPhaseTag(phaseTag({ contexts: ['topic'] }))).toBe(false)
		expect(isSkillPhaseTag(phaseTag({ contexts: [] }))).toBe(false)
		expect(isSkillPhaseTag(phaseTag({ contexts: null }))).toBe(false)
	})
})

describe('skillPhaseFromTag', () => {
	it('prefers popularity_order as the phase number', () => {
		const phase = skillPhaseFromTag(
			phaseTag({ popularity_order: 3, slug: 'phase-1' }),
		)
		// The explicit field wins over the slug — they disagree on purpose here.
		expect(phase?.number).toBe(3)
	})

	it('falls back to the slug when popularity_order is unset', () => {
		expect(skillPhaseFromTag(phaseTag({ slug: 'phase-7' }))?.number).toBe(7)
	})

	it('maps the utility slug to the sentinel number', () => {
		const phase = skillPhaseFromTag(
			phaseTag({ slug: 'phase-utility', label: 'Utility' }),
		)
		expect(phase?.number).toBe(SKILL_PHASE_UTILITY_NUMBER)
	})

	it('returns null when neither source yields a number', () => {
		// A skill with no usable phase renders without a badge — it is never
		// dropped from the set, so null is the expected answer, not an error.
		expect(skillPhaseFromTag(phaseTag({ slug: 'not-a-phase' }))).toBeNull()
		expect(skillPhaseFromTag(phaseTag({ slug: 'phase-' }))).toBeNull()
	})

	it('strips the "Phase N:" prefix for the display name', () => {
		expect(skillPhaseFromTag(phaseTag())?.name).toBe('Idea')
		expect(
			skillPhaseFromTag(phaseTag({ label: 'phase 2 : Research' }))?.name,
		).toBe('Research')
	})

	it('passes a label through untouched when it has no prefix', () => {
		const phase = skillPhaseFromTag(
			phaseTag({ label: 'Groundwork', popularity_order: 1 }),
		)
		expect(phase?.name).toBe('Groundwork')
	})

	it('keeps the full label and slug alongside the derived name', () => {
		const phase = skillPhaseFromTag(phaseTag())
		expect(phase).toEqual({
			number: 1,
			name: 'Idea',
			label: 'Phase 1: Idea',
			slug: 'phase-1',
		})
	})

	it('falls back to the raw label when stripping would empty it', () => {
		const phase = skillPhaseFromTag(
			phaseTag({ label: 'Phase 4:', popularity_order: 4 }),
		)
		expect(phase?.name).toBe('Phase 4:')
	})
})
