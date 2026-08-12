import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getSubscriber: vi.fn() }))

vi.mock('server-only', () => ({}))
vi.mock('@/coursebuilder/email-list-provider', () => ({
	emailListProvider: { getSubscriber: mocks.getSubscriber },
}))
vi.mock('@/lib/email-preferences', () => ({
	hashEmailForKit: () => 'a'.repeat(64),
}))

import { resolvePromptSubscriberContext } from './prompt-subscriber-context'

describe('prompt Kit subscriber context', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('recognizes a provider-backed subscriber id without treating it as full auth', async () => {
		mocks.getSubscriber.mockResolvedValue({
			id: 4123456789,
			email_address: 'reader@example.com',
		})

		await expect(
			resolvePromptSubscriberContext({ subscriberId: '4123456789' }),
		).resolves.toEqual({
			status: 'recognized',
			provider: 'kit',
			readAccess: 'published_prompt_and_event_only',
			identityAssurance: 'subscriber_id',
		})
	})

	it('verifies the subscriber id when Kit also supplies its email hash', async () => {
		const email = 'reader@example.com'
		mocks.getSubscriber.mockResolvedValue({ id: 4123456789, email_address: email })

		await expect(
			resolvePromptSubscriberContext({
				subscriberId: '4123456789',
				shKit: 'a'.repeat(64),
			}),
		).resolves.toMatchObject({
			status: 'verified',
			identityAssurance: 'subscriber_id_and_email_hash',
		})
	})

	it('rejects malformed ids without querying Kit', async () => {
		await expect(
			resolvePromptSubscriberContext({ subscriberId: 'not-an-id' }),
		).resolves.toMatchObject({ status: 'invalid' })
		expect(mocks.getSubscriber).not.toHaveBeenCalled()
	})
})
