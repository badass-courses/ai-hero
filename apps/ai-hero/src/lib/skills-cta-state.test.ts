import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getSubscriberFromCookie: vi.fn(),
	getSubscriberByEmail: vi.fn(),
}))

vi.mock('@/lib/convertkit', () => ({
	getSubscriberFromCookie: mocks.getSubscriberFromCookie,
}))

vi.mock('@/coursebuilder/email-list-provider', () => ({
	emailListProvider: {
		getSubscriberByEmail: mocks.getSubscriberByEmail,
	},
}))

import { resolveSkillsCtaState } from './skills-cta-state'

describe('resolveSkillsCtaState', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('refreshes an incomplete cookie after the async course-start update', async () => {
		mocks.getSubscriberFromCookie.mockResolvedValue({
			id: 42,
			email_address: 'learner@example.com',
			state: 'active',
			fields: { interest: 'skills' },
		})
		mocks.getSubscriberByEmail.mockResolvedValue({
			id: 42,
			email_address: 'learner@example.com',
			state: 'active',
			fields: {
				interest: 'skills',
				aih_course_started_at: '2026-07-31T12:00:00.000Z',
			},
		})

		await expect(resolveSkillsCtaState()).resolves.toBe('subscribed')
		expect(mocks.getSubscriberByEmail).toHaveBeenCalledWith(
			'learner@example.com',
		)
	})

	it('keeps the one-click CTA when the refreshed record has not started', async () => {
		mocks.getSubscriberFromCookie.mockResolvedValue({
			id: 42,
			email_address: 'learner@example.com',
			state: 'active',
			fields: { interest: 'skills' },
		})
		mocks.getSubscriberByEmail.mockResolvedValue({
			id: 42,
			email_address: 'learner@example.com',
			state: 'active',
			fields: { interest: 'skills' },
		})

		await expect(resolveSkillsCtaState()).resolves.toBe('tag-me')
	})
})
