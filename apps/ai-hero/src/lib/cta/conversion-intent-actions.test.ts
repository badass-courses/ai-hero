import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	resolveEnrolmentIdentity: vi.fn(),
	setSubscriberCookie: vi.fn(),
	subscribeToList: vi.fn(),
	tagSubscriber: vi.fn(),
	log: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}))

vi.mock('@/coursebuilder/email-list-provider', () => ({
	emailListProvider: {
		subscribeToList: mocks.subscribeToList,
		tagSubscriber: mocks.tagSubscriber,
	},
}))

vi.mock('@/env.mjs', () => ({
	env: { CONVERTKIT_SIGNUP_FORM: 123 },
}))

vi.mock('@/lib/convertkit', () => ({
	setSubscriberCookie: mocks.setSubscriberCookie,
}))

vi.mock('@/lib/enrolment-identity', () => ({
	resolveEnrolmentIdentity: mocks.resolveEnrolmentIdentity,
}))

vi.mock('@/schemas/subscriber', () => ({
	SubscriberSchema: { parse: (value: unknown) => value },
}))

vi.mock('@/server/logger', () => ({ log: mocks.log }))

import { completeKnownConversionIntent } from './conversion-intent-actions'

describe('completeKnownConversionIntent', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-07-31T12:00:00Z'))
		mocks.resolveEnrolmentIdentity.mockResolvedValue({
			identity: {
				email: 'signed-in@example.com',
				name: 'Vojta',
				via: 'session',
			},
			subscriber: null,
		})
		mocks.subscribeToList.mockResolvedValue({
			id: 42,
			email_address: 'signed-in@example.com',
			state: 'active',
			fields: {},
		})
		mocks.tagSubscriber.mockResolvedValue(undefined)
	})

	it('writes the canonical waitlist field and matching tag for a known reader', async () => {
		const result = await completeKnownConversionIntent({
			intent: { kind: 'cohort-waitlist', productName: 'Cohort Four' },
			surface: 'homepage-cohort',
		})

		expect(result).toEqual({ success: true, confirmationRequired: false })
		expect(mocks.subscribeToList).toHaveBeenCalledWith({
			listId: 123,
			listType: 'form',
			user: { email: 'signed-in@example.com', name: 'Vojta' },
			fields: {
				waitlist_cohort_four: '2026-07-31',
				source: 'aihero_homepage_cohort',
			},
		})
		expect(mocks.tagSubscriber).toHaveBeenCalledWith({
			tag: 'waitlist_cohort_four',
			email: 'signed-in@example.com',
		})
		expect(mocks.setSubscriberCookie).toHaveBeenCalledWith(
			expect.objectContaining({
				fields: {
					waitlist_cohort_four: '2026-07-31',
					source: 'aihero_homepage_cohort',
				},
			}),
		)
	})

	it('does not ask Kit to mutate anything when identity cannot be resolved', async () => {
		mocks.resolveEnrolmentIdentity.mockResolvedValue({
			identity: null,
			subscriber: null,
		})

		await expect(
			completeKnownConversionIntent({
				intent: { kind: 'cohort-waitlist', productName: 'Cohort Four' },
				surface: 'courses-cohort',
			}),
		).resolves.toEqual({ success: false, reason: 'not-identified' })
		expect(mocks.subscribeToList).not.toHaveBeenCalled()
	})

	it('reports confirmation required for an inactive Kit subscriber', async () => {
		mocks.subscribeToList.mockResolvedValue({
			id: 42,
			email_address: 'signed-in@example.com',
			state: 'inactive',
			fields: {},
		})

		await expect(
			completeKnownConversionIntent({
				intent: { kind: 'cohort-waitlist', productName: 'Cohort Four' },
				surface: 'cohort-page',
			}),
		).resolves.toEqual({ success: true, confirmationRequired: true })
	})

	it('keeps a successful field write successful when tag projection fails', async () => {
		mocks.tagSubscriber.mockRejectedValue(new Error('Kit tag API unavailable'))

		await expect(
			completeKnownConversionIntent({
				intent: { kind: 'cohort-waitlist', productName: 'Cohort Four' },
				surface: 'cohort-page',
			}),
		).resolves.toEqual({ success: true, confirmationRequired: false })
		expect(mocks.log.error).toHaveBeenCalledWith(
			'cta.intent.tag.failed',
			expect.objectContaining({ tagName: 'waitlist_cohort_four' }),
		)
	})
})
