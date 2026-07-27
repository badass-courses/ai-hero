import { describe, expect, it } from 'vitest'

import { verifyValuePathToken } from './path-token'
import { buildValuePathAnswerLinks } from './value-path-answer-links'
import {
	SHARED_SKILLS_WORKFLOW_CERTIFICATE_ANSWER_SLUG,
	type ValuePathAnswerPageResource,
} from './value-path-answer-page'

const secret = 'answer-link-test-secret'
const tokenPayload = {
	contactId: 'contact-1',
	kitSubscriberId: 'kit-1',
	valuePathResourceId: 'ai-hero-skills-workflow',
	emailResourceId: 'ai-hero-skills-workflow.email-7',
	sequenceId: 'ai-hero-skills-workflow',
	expiresAt: '2026-08-18T00:00:00.000Z',
}

function answerPage(
	optionValue: string,
	position: number,
): ValuePathAnswerPageResource {
	return {
		id: `answer-${optionValue}`,
		type: 'value-path-page',
		fields: {
			kind: 'answer',
			slug: SHARED_SKILLS_WORKFLOW_CERTIFICATE_ANSWER_SLUG,
			sequenceId: 'ai-hero-skills-workflow',
			emailId: 'email-7',
			surveyId: 'email-7-finisher-segment',
			optionValue,
			result: optionValue,
			position,
		},
	}
}

describe('shared certificate answer links', () => {
	it('uses one route and carries the selected segment as a separate query value', () => {
		const links = buildValuePathAnswerLinks({
			baseUrl: 'https://www.aihero.dev',
			secret,
			tokenPayload,
			answerPages: [answerPage('other', 4), answerPage('shipping', 1)],
		})

		expect(links).toHaveLength(2)
		const urls = links.map((link) => new URL(link.href))
		expect(urls.map((url) => url.pathname)).toEqual([
			`/ask/${SHARED_SKILLS_WORKFLOW_CERTIFICATE_ANSWER_SLUG}`,
			`/ask/${SHARED_SKILLS_WORKFLOW_CERTIFICATE_ANSWER_SLUG}`,
		])
		expect(urls.map((url) => url.searchParams.get('answer'))).toEqual([
			'shipping',
			'other',
		])
		for (const url of urls) {
			expect(
				verifyValuePathToken({
					token: url.searchParams.get('pt'),
					secret,
					now: new Date('2026-07-18T00:00:00.000Z'),
				}),
			).toMatchObject({ valid: true, payload: tokenPayload })
		}
	})
})
