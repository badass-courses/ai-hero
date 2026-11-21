import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/subscriber-marketing/value-path-answer-page', () => ({
	getValuePathAnswerPageBySlug: vi.fn(async () => null),
	SHARED_SKILLS_WORKFLOW_CERTIFICATE_ANSWER_SLUG: 'shared-certificate',
}))

import { signValuePathToken } from '@/lib/subscriber-marketing/path-token'
import { resolveAnswerLanding } from './answer-landing'

const payload = {
	contactId: 'contact-1',
	valuePathResourceId: 'value-path:ai-hero-skills-workflow',
	emailResourceId: 'ai-hero-skills-workflow.email-1',
	sequenceId: 'seq-1',
	expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
}
// The literal that used to be the committed fallback.
const committedLiteral = ['dev', 'value', 'path', 'token', 'secret'].join('-')

beforeEach(() => {
	vi.unstubAllEnvs()
})
afterEach(() => {
	vi.unstubAllEnvs()
})

describe('answer landing path-token secret', () => {
	it('refuses to verify anything when the secret is unset', async () => {
		vi.stubEnv('AI_HERO_VALUE_PATH_TOKEN_SECRET', '')
		const forged = signValuePathToken({ payload, secret: committedLiteral })
		await expect(
			resolveAnswerLanding({ slug: 'any', pt: forged }),
		).rejects.toThrow('AI_HERO_VALUE_PATH_TOKEN_SECRET is not configured')
	})

	it('rejects a token signed with the old committed literal', async () => {
		vi.stubEnv(
			'AI_HERO_VALUE_PATH_TOKEN_SECRET',
			'a-real-secret-of-adequate-length',
		)
		const forged = signValuePathToken({ payload, secret: committedLiteral })
		const out = await resolveAnswerLanding({ slug: 'any', pt: forged })
		expect(out.token).toMatchObject({ valid: false, reason: 'tampered' })
	})
})
