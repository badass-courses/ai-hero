import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const kitUnreachable = () =>
	Promise.reject(new Error('Kit is unreachable in this test'))

const mocks = vi.hoisted(() => ({
	cookies: new Map<string, string>(),
	responses: [] as Array<Record<string, any>>,
	findProviderIdentity: vi.fn(),
	findContact: vi.fn(),
	findUser: vi.fn(),
	findContentResource: vi.fn(),
	findRelation: vi.fn(),
	persistSurveyAnswers: vi.fn(),
	getSubscriber: vi.fn(),
	getSubscriberByEmail: vi.fn(),
	updateSubscriberFields: vi.fn(),
	getSubscriberFromCookie: vi.fn(),
}))

vi.mock('next/headers', () => ({
	cookies: async () => ({
		get: (name: string) =>
			mocks.cookies.has(name)
				? { name, value: mocks.cookies.get(name)! }
				: undefined,
	}),
	headers: async () => new Headers(),
}))
vi.mock('@/db', () => ({
	db: {
		query: {
			providerIdentity: { findFirst: mocks.findProviderIdentity },
			contact: { findFirst: mocks.findContact },
			users: { findFirst: mocks.findUser },
			contentResource: { findFirst: mocks.findContentResource },
			contentResourceResource: { findFirst: mocks.findRelation },
			// The read the buy button makes before showing the question.
			questionResponse: {
				findFirst: async () => mocks.responses.at(-1),
			},
		},
		insert: vi.fn(),
	},
}))
vi.mock('@/lib/survey-answer-persistence', () => ({
	persistSurveyAnswers: mocks.persistSurveyAnswers,
}))
vi.mock('@/coursebuilder/email-list-provider', () => ({
	emailListProvider: {
		getSubscriber: mocks.getSubscriber,
		getSubscriberByEmail: mocks.getSubscriberByEmail,
		updateSubscriberFields: mocks.updateSubscriberFields,
	},
}))
vi.mock('@/lib/convertkit', () => ({
	getSubscriberFromCookie: mocks.getSubscriberFromCookie,
}))
vi.mock('@/server/auth', () => ({ getServerAuthSession: vi.fn() }))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { convertkitRouter } from './convertkit'

function caller(session: { user: { id?: string; email?: string } } | null) {
	return convertkitRouter.createCaller({
		db: null,
		session,
		ability: null,
		headers: new Headers(),
	} as any)
}

function persisted() {
	return mocks.persistSurveyAnswers.mock.calls[0]![0]
}

describe('convertkit.answerCheckoutSurvey with Kit unreachable', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.cookies.clear()
		mocks.responses.length = 0
		for (const kitCall of [
			mocks.getSubscriber,
			mocks.getSubscriberByEmail,
			mocks.updateSubscriberFields,
			mocks.getSubscriberFromCookie,
		]) {
			kitCall.mockImplementation(kitUnreachable)
		}
		mocks.findProviderIdentity.mockResolvedValue(undefined)
		mocks.findContact.mockResolvedValue(undefined)
		mocks.findUser.mockResolvedValue(undefined)
		mocks.findContentResource.mockImplementation(async () => ({
			id: 'existing-resource',
		}))
		mocks.findRelation.mockResolvedValue({ resourceId: 'existing-resource' })
		mocks.persistSurveyAnswers.mockImplementation(async (input) => {
			mocks.responses.push({
				userId: input.userId,
				emailListSubscriberId: input.emailListSubscriberId,
				fields: { answer: Object.values(input.answers)[0] },
			})
			return { answerCount: 1 }
		})
	})

	afterEach(() => {
		expect(mocks.getSubscriber).not.toHaveBeenCalled()
		expect(mocks.getSubscriberByEmail).not.toHaveBeenCalled()
		expect(mocks.updateSubscriberFields).not.toHaveBeenCalled()
		expect(mocks.getSubscriberFromCookie).not.toHaveBeenCalled()
	})

	it('reads unanswered, saves the answer locally, then reads answered', async () => {
		mocks.cookies.set('ck_subscriber_id', '1234567')
		const api = caller(null)

		await expect(api.checkoutSurveyAnswer()).resolves.toEqual({
			answered: false,
			answer: null,
		})

		await expect(
			api.answerCheckoutSurvey({ answer: 'matts_youtube' }),
		).resolves.toEqual({ success: true, storedInDb: true })

		expect(persisted()).toMatchObject({
			surveySlug: 'checkout-decision-source',
			answers: { 'what-helped-you-decide-to-join': 'matts_youtube' },
			emailListSubscriberId: '1234567',
			userId: null,
			identityEmail: null,
		})
		await expect(api.checkoutSurveyAnswer()).resolves.toEqual({
			answered: true,
			answer: 'matts_youtube',
		})
	})

	it('keys a Kit id cookie to its contact from the local directory', async () => {
		mocks.cookies.set('ck_subscriber_id', '"1234567"')
		mocks.findProviderIdentity.mockResolvedValue({ contactId: 'contact-1' })
		mocks.findContact.mockResolvedValue({
			email: 'buyer@example.test',
			userId: 'user-from-contact',
		})

		await caller(null).answerCheckoutSurvey({ answer: 'github' })

		expect(persisted()).toMatchObject({
			userId: 'user-from-contact',
			emailListSubscriberId: '1234567',
			identityEmail: 'buyer@example.test',
		})
		expect(mocks.findUser).not.toHaveBeenCalled()
	})

	it('finds the user by the contact email when the contact has no user', async () => {
		mocks.cookies.set('ck_subscriber_id', '1234567')
		mocks.findProviderIdentity.mockResolvedValue({ contactId: 'contact-1' })
		mocks.findContact.mockResolvedValue({
			email: 'buyer@example.test',
			userId: null,
		})
		mocks.findUser.mockResolvedValue({ id: 'user-by-email' })

		await caller(null).answerCheckoutSurvey({ answer: 'github' })

		expect(persisted()).toMatchObject({ userId: 'user-by-email' })
	})

	it('keys a signed-in buyer by their user', async () => {
		await caller({
			user: { id: 'user-1', email: 'buyer@example.test' },
		}).answerCheckoutSurvey({ answer: 'other' })

		expect(persisted()).toMatchObject({
			userId: 'user-1',
			emailListSubscriberId: null,
			identityEmail: 'buyer@example.test',
		})
		expect(mocks.findProviderIdentity).not.toHaveBeenCalled()
	})

	it('uses the ck_subscriber cookie snapshot without a directory read', async () => {
		mocks.cookies.set(
			'ck_subscriber',
			JSON.stringify({
				id: 7654321,
				first_name: null,
				email_address: 'buyer@example.test',
				state: 'active',
				created_at: '2026-01-01T00:00:00Z',
				fields: {},
			}),
		)

		await caller(null).answerCheckoutSurvey({ answer: 'podcast_newsletter' })

		expect(persisted()).toMatchObject({
			emailListSubscriberId: '7654321',
			identityEmail: 'buyer@example.test',
		})
		expect(mocks.findProviderIdentity).not.toHaveBeenCalled()
	})

	it('still saves when the directory read fails', async () => {
		mocks.cookies.set('ck_subscriber_id', '1234567')
		mocks.findProviderIdentity.mockRejectedValue(new Error('db hiccup'))

		await expect(
			caller(null).answerCheckoutSurvey({ answer: 'github' }),
		).resolves.toEqual({ success: true, storedInDb: true })
		expect(persisted()).toMatchObject({
			emailListSubscriberId: '1234567',
			userId: null,
		})
	})

	it('reports a failed save without throwing, so checkout continues', async () => {
		mocks.persistSurveyAnswers.mockRejectedValue(new Error('db down'))

		await expect(
			caller(null).answerCheckoutSurvey({ answer: 'github' }),
		).resolves.toEqual({ success: false, storedInDb: false })
	})

	it('rejects an answer that is not one of the checkout choices', async () => {
		await expect(
			caller(null).answerCheckoutSurvey({ answer: 'anything' }),
		).rejects.toThrow()
		expect(mocks.persistSurveyAnswers).not.toHaveBeenCalled()
	})
})
