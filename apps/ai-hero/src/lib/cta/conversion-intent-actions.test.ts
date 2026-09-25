import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	resolveEnrolmentIdentity: vi.fn(),
	isSignedInAs: vi.fn(),
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
	isSignedInAs: mocks.isSignedInAs,
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
		mocks.isSignedInAs.mockResolvedValue(true)
	})

	describe('a reader ai-hero verified whom Kit still holds unconfirmed', () => {
		// System time is 2026-07-31T12:00:00Z.
		const inactive = (createdAt: string | null = '2026-07-31T12:00:00Z') =>
			mocks.subscribeToList.mockResolvedValue({
				id: 4295840642,
				email_address: 'signed-in@example.com',
				state: 'inactive',
				...(createdAt ? { created_at: createdAt } : {}),
				fields: {},
			})
		const allLogs = () =>
			JSON.stringify([
				...mocks.log.info.mock.calls,
				...mocks.log.warn.mock.calls,
				...mocks.log.error.mock.calls,
			])

		it('is logged with the Kit id and intent key, never the address', async () => {
			inactive()
			await completeKnownConversionIntent({
				intent: { kind: 'cohort-waitlist', productName: 'Cohort Four' },
				surface: 'cohort-page',
			})
			expect(mocks.log.warn).toHaveBeenCalledWith(
				'kit.subscriber.verified_unconfirmed',
				{
					kitSubscriberId: '4295840642',
					intentKey: 'waitlist:cohort:cohort_four',
					via: 'session',
					state: 'inactive',
					kitCreatedAt: '2026-07-31T12:00:00Z',
					resubmit: false,
				},
			)
			expect(mocks.isSignedInAs).toHaveBeenCalledWith(
				expect.objectContaining({ via: 'session' }),
			)
			expect(allLogs()).not.toContain('signed-in@example.com')
		})

		it('marks a re-submit: Kit created the subscriber long before this signup', async () => {
			// The cnv_1ojzdqat shape: unconfirmed since an earlier signup.
			inactive('2026-07-20T06:32:55Z')
			await completeKnownConversionIntent({
				intent: { kind: 'cohort-waitlist', productName: 'Cohort Four' },
				surface: 'cohort-page',
			})
			expect(mocks.log.warn).toHaveBeenCalledWith(
				'kit.subscriber.verified_unconfirmed',
				expect.objectContaining({
					kitCreatedAt: '2026-07-20T06:32:55Z',
					resubmit: true,
				}),
			)
		})

		it('treats a subscriber created within five minutes as this signup, not a re-submit', async () => {
			inactive('2026-07-31T11:56:00Z')
			await completeKnownConversionIntent({
				intent: { kind: 'cohort-waitlist', productName: 'Cohort Four' },
				surface: 'cohort-page',
			})
			expect(mocks.log.warn).toHaveBeenCalledWith(
				'kit.subscriber.verified_unconfirmed',
				expect.objectContaining({ resubmit: false }),
			)
		})

		it('says so when Kit returned no creation time', async () => {
			inactive(null)
			await completeKnownConversionIntent({
				intent: { kind: 'cohort-waitlist', productName: 'Cohort Four' },
				surface: 'cohort-page',
			})
			expect(mocks.log.warn).toHaveBeenCalledWith(
				'kit.subscriber.verified_unconfirmed',
				expect.objectContaining({ kitCreatedAt: null, resubmit: false }),
			)
		})

		it('is logged for a cookie-identified reader who is also signed in as that address', async () => {
			inactive()
			mocks.resolveEnrolmentIdentity.mockResolvedValue({
				identity: { email: 'signed-in@example.com', via: 'cookie' },
				subscriber: null,
			})
			await completeKnownConversionIntent({
				intent: { kind: 'newsletter' },
				surface: 'post-closing',
			})
			expect(mocks.log.warn).toHaveBeenCalledWith(
				'kit.subscriber.verified_unconfirmed',
				expect.objectContaining({ intentKey: 'newsletter', via: 'cookie' }),
			)
		})

		it('is not logged when only a cookie vouches for the address', async () => {
			inactive()
			mocks.isSignedInAs.mockResolvedValue(false)
			mocks.resolveEnrolmentIdentity.mockResolvedValue({
				identity: { email: 'signed-in@example.com', via: 'cookie' },
				subscriber: null,
			})
			await completeKnownConversionIntent({
				intent: { kind: 'cohort-waitlist', productName: 'Cohort Four' },
				surface: 'cohort-page',
			})
			expect(mocks.log.warn).not.toHaveBeenCalledWith(
				'kit.subscriber.verified_unconfirmed',
				expect.anything(),
			)
		})

		it('is not logged for a confirmed subscriber', async () => {
			await completeKnownConversionIntent({
				intent: { kind: 'cohort-waitlist', productName: 'Cohort Four' },
				surface: 'cohort-page',
			})
			expect(mocks.log.warn).not.toHaveBeenCalledWith(
				'kit.subscriber.verified_unconfirmed',
				expect.anything(),
			)
			expect(mocks.isSignedInAs).not.toHaveBeenCalled()
		})
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
