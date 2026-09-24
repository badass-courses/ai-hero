import { describe, expect, it } from 'vitest'

import { parseValuePathAnswerPageResource } from './value-path-answer-page'
import { recordValuePathAnswerProgression } from './value-path-click-progression'

const answerPage = parseValuePathAnswerPageResource({
	id: 'answer-email-1-correct',
	type: 'value-path-page',
	fields: {
		kind: 'answer',
		slug: 'skills-workflow-email-1-correct',
		sequenceId: 'ai-hero-skills-workflow',
		emailId: 'email-1',
		optionValue: 'correct',
		nextEmailResourceId: 'ai-hero-skills-workflow.email-2',
		kitSequenceId: '2757201',
	},
})

describe('answer progression for a synthetic test principal', () => {
	it('skips before touching the repository: no answer, no path advance, no event', async () => {
		const touched: string[] = []
		const repository = new Proxy(
			{},
			{
				get: (_target, property) => () => {
					touched.push(String(property))
					throw new Error(`repository.${String(property)} touched`)
				},
			},
		)
		const result = await recordValuePathAnswerProgression({
			repository: repository as never,
			token: {
				contactId: 'synthetic_run-1',
				kitSubscriberId: 'kit-synthetic',
				valuePathResourceId: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-1',
				sequenceId: 'ai-hero-skills-workflow',
				expiresAt: '2026-10-01T00:00:00.000Z',
			},
			answerPage: answerPage!,
		})
		expect(result).toEqual({
			status: 'skipped',
			reason: 'synthetic-principal',
			idempotentNoop: false,
			reviewReasons: ['synthetic-principal'],
		})
		expect(answerPage).not.toBeNull()
		expect(touched).toEqual([])
	})
})
