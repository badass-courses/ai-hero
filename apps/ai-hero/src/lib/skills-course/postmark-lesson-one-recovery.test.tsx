import { describe, expect, it, vi } from 'vitest'

import { buildSkillsCourseLessonOneEmail } from './lesson-one-email'
import { createPostmarkSkillsLessonOneRecoveryProvider } from './postmark-lesson-one-recovery'

const EMAIL = buildSkillsCourseLessonOneEmail({
	aih_value_path_answer_links_json: JSON.stringify([
		{ optionValue: 'personal', href: 'https://example.com/personal' },
		{ optionValue: 'team', href: 'https://example.com/team' },
		{ optionValue: 'unsure', href: 'https://example.com/unsure' },
	]),
})

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

describe('Postmark Skills lesson one recovery provider', () => {
	it('writes a recovery key and returns the accepted message id', async () => {
		const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body))
			expect(body.To).toBe('learner@example.com')
			expect(body.Tag).toBe('skills-lesson-one-recovery')
			expect(body.Metadata).toEqual({ recovery_key: 'recovery_hash' })
			return jsonResponse({
				ErrorCode: 0,
				Message: 'OK',
				MessageID: 'message_1',
			})
		})
		const provider = createPostmarkSkillsLessonOneRecoveryProvider({
			apiKey: 'test-key',
			from: 'AI Hero <support@example.com>',
			replyTo: 'support@example.com',
			fetch: fetchMock,
		})

		const result = await provider.send({
			recipient: 'learner@example.com',
			providerRecoveryKey: 'recovery_hash',
			email: EMAIL,
		})

		expect(result).toEqual({ state: 'accepted', messageId: 'message_1' })
	})

	it('finds an exact provider message by recipient, tag, and recovery metadata', async () => {
		const fetchMock = vi.fn(async (request: string | URL | Request) => {
			const url = new URL(request.toString())
			expect(url.searchParams.get('recipient')).toBe('learner@example.com')
			expect(url.searchParams.get('tag')).toBe(
				'skills-lesson-one-recovery',
			)
			expect(url.searchParams.get('metadata_recovery_key')).toBe(
				'recovery_hash',
			)
			return jsonResponse({
				Messages: [
					{
						MessageID: 'message_1',
						Status: 'Sent',
						Recipients: ['learner@example.com'],
						Metadata: { recovery_key: 'recovery_hash' },
					},
				],
			})
		})
		const provider = createPostmarkSkillsLessonOneRecoveryProvider({
			apiKey: 'test-key',
			from: 'AI Hero <support@example.com>',
			replyTo: 'support@example.com',
			fetch: fetchMock,
		})

		const result = await provider.findByRecoveryKey({
			recipient: 'learner@example.com',
			providerRecoveryKey: 'recovery_hash',
		})

		expect(result).toEqual({
			messageId: 'message_1',
			status: 'Sent',
			recipient: 'learner@example.com',
			providerRecoveryKey: 'recovery_hash',
		})
	})

	it('marks HTTP 429 as a retryable rejection', async () => {
		const provider = createPostmarkSkillsLessonOneRecoveryProvider({
			apiKey: 'test-key',
			from: 'AI Hero <support@example.com>',
			replyTo: 'support@example.com',
			fetch: vi.fn(async () =>
				jsonResponse({ ErrorCode: 429, Message: 'rate limited' }, 429),
			),
		})

		await expect(
			provider.send({
				recipient: 'learner@example.com',
				providerRecoveryKey: 'recovery_hash',
				email: EMAIL,
			}),
		).resolves.toEqual({
			state: 'rejected',
			reason: 'postmark-429',
			retryable: true,
		})
	})
})
