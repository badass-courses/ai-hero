import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/emails/basic-email', () => ({ default: vi.fn(() => null) }))
vi.mock('@react-email/render', () => ({
	render: vi.fn(async () => '<p>hi</p>'),
}))

import {
	readSkillsCourseRecoveryDelivery,
	sendSkillsCourseRecoveryDelivery,
} from './skills-course-recovery-delivery'

describe('skills course recovery Postmark correlation', () => {
	const fetchImpl = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('adds a safe correlation id to Postmark metadata', async () => {
		fetchImpl.mockResolvedValue(
			Response.json({ ErrorCode: 0, MessageID: 'postmark-message-1' }),
		)

		await expect(
			sendSkillsCourseRecoveryDelivery({
				correlationId: 'request-safe-1',
				to: 'learner@example.com',
				subject: 'Lesson one',
				body: 'Body',
				preview: 'Preview',
				from: 'AI Hero <support@aihero.dev>',
				replyTo: 'support@aihero.dev',
				postmarkToken: 'postmark-test-token',
				fetchImpl,
			}),
		).resolves.toEqual({ messageId: 'postmark-message-1' })

		const [, init] = fetchImpl.mock.calls[0] ?? []
		const payload = JSON.parse(String(init?.body))
		expect(payload).toMatchObject({
			Tag: 'skills-course-lesson-one-recovery',
			Metadata: { recovery_request_id: 'request-safe-1' },
		})
	})

	it('reads accepted delivery by correlation before a replay', async () => {
		fetchImpl.mockResolvedValue(
			Response.json({ Messages: [{ MessageID: 'postmark-message-1' }] }),
		)

		await expect(
			readSkillsCourseRecoveryDelivery({
				correlationId: 'request-safe-1',
				postmarkToken: 'postmark-test-token',
				fetchImpl,
			}),
		).resolves.toEqual({
			found: true,
			messageId: 'postmark-message-1',
		})
		const [url, init] = fetchImpl.mock.calls[0] ?? []
		expect(String(url)).toContain('metadata_recovery_request_id=request-safe-1')
		expect(init).toMatchObject({ method: 'GET' })
	})
})
