import { describe, expect, it } from 'vitest'

import {
	SHARED_SKILLS_WORKFLOW_CERTIFICATE_ANSWER_SLUG,
	selectValuePathAnswerPageVariant,
	type ValuePathAnswerPageResource,
} from './value-path-answer-page'

function answerVariant(input: {
	id: string
	sequenceId: string
	emailId: string
	optionValue: string
	headline: string
}): ValuePathAnswerPageResource {
	return {
		id: input.id,
		type: 'value-path-page',
		fields: {
			kind: 'answer',
			slug: SHARED_SKILLS_WORKFLOW_CERTIFICATE_ANSWER_SLUG,
			sequenceId: input.sequenceId,
			emailId: input.emailId,
			surveyId: `${input.emailId}-finisher-segment`,
			optionValue: input.optionValue,
			result: input.optionValue,
			headline: input.headline,
			captureFieldKey: 'aih_finisher_segment',
			captureDateFieldKey: 'aih_next_course_waitlist_at',
		},
	}
}

const variants = [
	answerVariant({
		id: 'individual-shipping',
		sequenceId: 'ai-hero-skills-workflow',
		emailId: 'email-7',
		optionValue: 'shipping',
		headline: 'Noted. Builders first when the next course opens.',
	}),
	answerVariant({
		id: 'individual-other',
		sequenceId: 'ai-hero-skills-workflow',
		emailId: 'email-7',
		optionValue: 'other',
		headline: 'Noted. Your certificate is below.',
	}),
	answerVariant({
		id: 'team-other',
		sequenceId: 'ai-hero-skills-team-workflow',
		emailId: 'team-email-7',
		optionValue: 'other',
		headline: 'Noted. Your certificate is below.',
	}),
]

describe('shared Skills Workflow certificate answer page', () => {
	it('selects one thin content variant from the signed path and answer value', () => {
		expect(
			selectValuePathAnswerPageVariant(variants, {
				optionValue: 'other',
				sequenceId: 'ai-hero-skills-team-workflow',
				emailId: 'team-email-7',
			}),
		).toMatchObject({
			id: 'team-other',
			fields: {
				slug: SHARED_SKILLS_WORKFLOW_CERTIFICATE_ANSWER_SLUG,
				optionValue: 'other',
				headline: 'Noted. Your certificate is below.',
			},
		})
	})

	it('refuses an ambiguous duplicate variant instead of choosing one arbitrarily', () => {
		const duplicate = answerVariant({
			id: 'individual-other-duplicate',
			sequenceId: 'ai-hero-skills-workflow',
			emailId: 'email-7',
			optionValue: 'other',
			headline: 'Wrong duplicate.',
		})
		expect(
			selectValuePathAnswerPageVariant([...variants, duplicate], {
				optionValue: 'other',
				sequenceId: 'ai-hero-skills-workflow',
				emailId: 'email-7',
			}),
		).toBeUndefined()
	})

	it('refuses an unknown answer value instead of force-fitting a segment', () => {
		expect(
			selectValuePathAnswerPageVariant(variants, {
				optionValue: 'forced-choice',
				sequenceId: 'ai-hero-skills-workflow',
				emailId: 'email-7',
			}),
		).toBeUndefined()
	})
})
