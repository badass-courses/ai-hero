import { describe, expect, it } from 'vitest'

import {
	readbackShadowNewsletterSequences,
	SHADOW_NEWSLETTER_CATALOG_REVISION,
	SHADOW_NEWSLETTER_KIT_SEQUENCES,
	shadowNewsletterSequenceForMessage,
} from './drovr-shadow-newsletter'

describe('shadow newsletter Kit sequence table', () => {
	it('pins the ten catalog messages to the owner readback ids', () => {
		expect(SHADOW_NEWSLETTER_KIT_SEQUENCES).toEqual([
			{
				messageId: 'agents_md_big_problem_v1',
				position: 0,
				sequenceId: 2899143,
			},
			{
				messageId: 'skill_claude_tdd_v1',
				position: 3,
				sequenceId: 2899144,
			},
			{
				messageId: 'ai_feedback_loops_v1',
				position: 4,
				sequenceId: 2899145,
			},
			{
				messageId: 'classic_technique_with_ai_v1',
				position: 5,
				sequenceId: 2899146,
			},
			{
				messageId: 'how_llm_tokens_work_v1',
				position: 7,
				sequenceId: 2899147,
			},
			{
				messageId: 'hook_dangerous_git_v1',
				position: 8,
				sequenceId: 2899148,
			},
			{
				messageId: 'codebases_claude_loves_v1',
				position: 9,
				sequenceId: 2899149,
			},
			{
				messageId: 'viral_talk_v1',
				position: 10,
				sequenceId: 2899150,
			},
			{
				messageId: 'triage_backlog_v1',
				position: 11,
				sequenceId: 2899151,
			},
			{
				messageId: 'grill_me_replacement_v1',
				position: 12,
				sequenceId: 2899152,
			},
		])
		expect(
			shadowNewsletterSequenceForMessage(
				SHADOW_NEWSLETTER_CATALOG_REVISION,
				'grill_me_replacement_v1',
			),
		).toMatchObject({ sequenceId: 2899152, position: 12 })
		expect(
			shadowNewsletterSequenceForMessage(
				'kit-2625552-future',
				'grill_me_replacement_v1',
			),
		).toBeUndefined()
		expect(
			shadowNewsletterSequenceForMessage(
				SHADOW_NEWSLETTER_CATALOG_REVISION,
				'not-in-the-catalog-v9',
			),
		).toBeUndefined()
	})
})

describe('readbackShadowNewsletterSequences', () => {
	const isEmails = (url: string | URL | Request) =>
		String(url).endsWith('/emails')
	const idOf = (url: string | URL | Request) =>
		Number(
			String(url)
				.replace(/\/emails$/, '')
				.split('/')
				.pop(),
		)
	const sequenceJson = (id: number, overrides: Record<string, unknown> = {}) =>
		new Response(
			JSON.stringify({
				sequence: {
					id,
					active: true,
					hold: false,
					repeat: false,
					email_count: 1,
					...overrides,
				},
			}),
			{ status: 200 },
		)

	it('is ready only when all ten sequences have one published email', async () => {
		const seen: string[] = []
		const result = await readbackShadowNewsletterSequences({
			apiKey: 'k',
			fetch: (async (url: string | URL | Request, init?: RequestInit) => {
				seen.push(String(url))
				expect((init?.headers as Record<string, string>)['X-Kit-Api-Key']).toBe(
					'k',
				)
				if (isEmails(url)) {
					return new Response(
						JSON.stringify({ emails: [{ id: 1, published: true }] }),
						{
							status: 200,
						},
					)
				}
				return sequenceJson(idOf(url))
			}) as typeof fetch,
			now: () => '2026-09-19T00:00:00.000Z',
		})
		expect(result).toEqual({
			ready: true,
			problems: [],
			checkedAt: '2026-09-19T00:00:00.000Z',
		})
		expect(seen).toHaveLength(20)
	})

	it('reports a bad sequence and draft-only email by message id', async () => {
		const result = await readbackShadowNewsletterSequences({
			apiKey: 'k',
			fetch: (async (url: string | URL | Request) => {
				if (isEmails(url)) {
					return new Response(
						JSON.stringify({ emails: [{ id: 1, published: false }] }),
						{
							status: 200,
						},
					)
				}
				const id = idOf(url)
				if (id === 2_899_143) {
					return sequenceJson(id, { active: false, email_count: 0 })
				}
				return sequenceJson(id)
			}) as typeof fetch,
		})
		expect(result.ready).toBe(false)
		expect(result.problems).toEqual([
			'agents_md_big_problem_v1: sequence is not active',
			'agents_md_big_problem_v1: 0 emails, expected 1',
			'skill_claude_tdd_v1: 0 published of 1 emails, expected 1 of 1',
			'ai_feedback_loops_v1: 0 published of 1 emails, expected 1 of 1',
			'classic_technique_with_ai_v1: 0 published of 1 emails, expected 1 of 1',
			'how_llm_tokens_work_v1: 0 published of 1 emails, expected 1 of 1',
			'hook_dangerous_git_v1: 0 published of 1 emails, expected 1 of 1',
			'codebases_claude_loves_v1: 0 published of 1 emails, expected 1 of 1',
			'viral_talk_v1: 0 published of 1 emails, expected 1 of 1',
			'triage_backlog_v1: 0 published of 1 emails, expected 1 of 1',
			'grill_me_replacement_v1: 0 published of 1 emails, expected 1 of 1',
		])
	})

	it('refuses without a Kit key and makes no request', async () => {
		let calls = 0
		const result = await readbackShadowNewsletterSequences({
			apiKey: undefined,
			fetch: (async () => {
				calls += 1
				return new Response('{}')
			}) as typeof fetch,
		})
		expect(result.ready).toBe(false)
		expect(result.problems).toEqual(['Kit v4 API key is not configured'])
		expect(calls).toBe(0)
	})
})
