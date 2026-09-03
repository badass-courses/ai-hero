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

function createProvider(fetchMock: typeof fetch) {
	return createPostmarkSkillsLessonOneRecoveryProvider({
		apiKey: 'test-key',
		from: 'AI Hero <support@example.com>',
		replyTo: 'support@example.com',
		fetch: fetchMock,
	})
}

describe('Postmark Skills lesson one recovery provider', () => {
	it('writes recovery and content metadata and returns the accepted message id', async () => {
		const fetchMock = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body))
				expect(body.To).toBe('learner@example.com')
				expect(body.Tag).toBe('skills-lesson-one-recovery')
				expect(body.Metadata).toEqual({
					recovery_key: 'recovery_hash',
					content_hash: 'content_hash',
				})
				return jsonResponse({
					ErrorCode: 0,
					Message: 'OK',
					MessageID: 'message_1',
				})
			},
		)
		const provider = createProvider(fetchMock)

		const result = await provider.send({
			recipient: 'learner@example.com',
			providerRecoveryKey: 'recovery_hash',
			emailContentHash: 'content_hash',
			email: EMAIL,
		})

		expect(result).toEqual({ state: 'accepted', messageId: 'message_1' })
	})

	it('queries one Postmark metadata field and locally matches the content hash', async () => {
		const fetchMock = vi.fn(async (request: string | URL | Request) => {
			const url = new URL(request.toString())
			expect(url.searchParams.get('recipient')).toBe('learner@example.com')
			expect(url.searchParams.get('tag')).toBe(
				'skills-lesson-one-recovery',
			)
			expect(url.searchParams.get('metadata_recovery_key')).toBe(
				'recovery_hash',
			)
			expect(url.searchParams.get('metadata_content_hash')).toBeNull()
			return jsonResponse({
				Messages: [
					{
						MessageID: 'wrong_content',
						Status: 'Sent',
						Recipients: ['learner@example.com'],
						Metadata: {
							recovery_key: 'recovery_hash',
							content_hash: 'different_content',
						},
					},
					{
						MessageID: 'message_1',
						Status: 'Sent',
						Recipients: ['learner@example.com'],
						Metadata: {
							recovery_key: 'recovery_hash',
							content_hash: 'content_hash',
						},
					},
				],
			})
		})
		const provider = createProvider(fetchMock)

		const result = await provider.findByRecoveryKey({
			recipient: 'learner@example.com',
			providerRecoveryKey: 'recovery_hash',
			emailContentHash: 'content_hash',
		})

		expect(result).toEqual({
			messageId: 'message_1',
			status: 'Sent',
			recipient: 'learner@example.com',
			providerRecoveryKey: 'recovery_hash',
			emailContentHash: 'content_hash',
		})
	})

	it('marks HTTP 429 as a retryable rejection', async () => {
		const provider = createProvider(
			vi.fn(async () =>
				jsonResponse({ ErrorCode: 429, Message: 'rate limited' }, 429),
			),
		)

		await expect(
			provider.send({
				recipient: 'learner@example.com',
				providerRecoveryKey: 'recovery_hash',
				emailContentHash: 'content_hash',
				email: EMAIL,
			}),
		).resolves.toEqual({
			state: 'rejected',
			reason: 'postmark-429',
			retryable: true,
		})
	})

	it('treats an HTTP 5xx response as ambiguous and unsafe to retry', async () => {
		const provider = createProvider(
			vi.fn(async () =>
				jsonResponse({ ErrorCode: 500, Message: 'server error' }, 500),
			),
		)

		await expect(
			provider.send({
				recipient: 'learner@example.com',
				providerRecoveryKey: 'recovery_hash',
				emailContentHash: 'content_hash',
				email: EMAIL,
			}),
		).resolves.toEqual({
			state: 'ambiguous',
			reason: 'postmark-http-500',
		})
	})
})
