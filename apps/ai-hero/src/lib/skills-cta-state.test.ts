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
	beforeEach(async () => {
		vi.clearAllMocks()
		vi.useRealTimers()
		const { clearSkillsCtaKitLookupCache } = await import('./skills-cta-state')
		clearSkillsCtaKitLookupCache()
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

	it('falls back to the cookie state when Kit exceeds the render deadline', async () => {
		vi.useFakeTimers()
		mocks.getSubscriberFromCookie.mockResolvedValue({
			id: 42,
			email_address: 'learner@example.com',
			state: 'active',
			fields: { interest: 'skills' },
		})
		mocks.getSubscriberByEmail.mockReturnValue(new Promise(() => {}))

		const result = resolveSkillsCtaState()
		await vi.advanceTimersByTimeAsync(1_500)

		await expect(result).resolves.toBe('tag-me')
	})

	it('remembers a definitive Kit answer and asks only once', async () => {
		mocks.getSubscriberFromCookie.mockResolvedValue(null)
		mocks.getSubscriberByEmail.mockResolvedValue({
			state: 'active',
			fields: {},
		})

		await expect(resolveSkillsCtaState('a@example.com')).resolves.toBe(
			'tag-me',
		)
		await expect(resolveSkillsCtaState('a@example.com')).resolves.toBe(
			'tag-me',
		)
		expect(mocks.getSubscriberByEmail).toHaveBeenCalledTimes(1)
	})

	it('remembers a transitional answer briefly and a terminal one longer', async () => {
		// The async course-start case from the resolver's own comment: the
		// learner-flow executor writes aih_course_started_at AFTER signup, and
		// this refresh is what repairs the cookie's stale answer — so tag-me
		// must not outlive that lag in the memo, while subscribed (nothing
		// un-starts a course) may.
		const { kitLookupRemainingTtlForTests } = await import(
			'./skills-cta-state'
		)
		mocks.getSubscriberFromCookie.mockResolvedValue(null)
		mocks.getSubscriberByEmail.mockResolvedValue({
			state: 'active',
			fields: { interest: 'skills' },
		})
		await expect(resolveSkillsCtaState('c@example.com')).resolves.toBe(
			'tag-me',
		)
		// ≤ a minute-and-change (perf-clock float fuzz), far below the terminal
		// tier — the tiers are what the assertion pins, not the exact millisecond.
		expect(kitLookupRemainingTtlForTests('c@example.com')).toBeLessThan(65_000)

		mocks.getSubscriberByEmail.mockResolvedValue({
			state: 'active',
			fields: {
				interest: 'skills',
				aih_course_started_at: '2026-08-03T12:00:00.000Z',
			},
		})
		await expect(resolveSkillsCtaState('d@example.com')).resolves.toBe(
			'subscribed',
		)
		expect(kitLookupRemainingTtlForTests('d@example.com')).toBeGreaterThan(
			65_000,
		)
	})

	it('does not remember a failed lookup', async () => {
		// A Kit outage answered "account" for this request — pinning that for
		// the TTL would misdraw the ask for a genuinely subscribed reader.
		mocks.getSubscriberFromCookie.mockResolvedValue(null)
		mocks.getSubscriberByEmail.mockRejectedValueOnce(new Error('kit down'))

		await expect(resolveSkillsCtaState('b@example.com')).resolves.toBe(
			'account',
		)

		mocks.getSubscriberByEmail.mockResolvedValue({
			state: 'active',
			fields: {},
		})
		await expect(resolveSkillsCtaState('b@example.com')).resolves.toBe(
			'tag-me',
		)
		expect(mocks.getSubscriberByEmail).toHaveBeenCalledTimes(2)
	})
})
