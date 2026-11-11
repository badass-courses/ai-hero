import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getSubscriberFromCookie: vi.fn(),
	getServerAuthSession: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/convertkit', () => ({
	getSubscriberFromCookie: mocks.getSubscriberFromCookie,
}))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))

import { isSignedInAs, resolveEnrolmentIdentity } from './enrolment-identity'

const subscriber = {
	id: 1,
	email_address: 'old@example.test',
	first_name: 'Cookie Name',
	state: 'active',
	fields: {},
}

function signIn(email: string) {
	mocks.getServerAuthSession.mockResolvedValue({
		session: { user: { email, name: 'Session Name' } },
	})
}

describe('resolveEnrolmentIdentity', () => {
	beforeEach(() => {
		vi.resetAllMocks()
		mocks.getSubscriberFromCookie.mockResolvedValue(subscriber)
		mocks.getServerAuthSession.mockResolvedValue(null)
	})

	it('uses the session on mismatch and excludes the stale cookie from caller fallbacks', async () => {
		signIn('new@example.test')
		const result = await resolveEnrolmentIdentity()
		expect(result).toEqual({
			identity: {
				email: 'new@example.test',
				name: 'Session Name',
				via: 'session',
			},
			subscriber: null,
		})
		expect(await isSignedInAs(result.identity!)).toBe(true)
	})

	it.each(['old@example.test', ' OLD@EXAMPLE.TEST '])(
		'preserves the Kit record when the session matches %s',
		async (email) => {
			signIn(email)
			expect(await resolveEnrolmentIdentity()).toEqual({
				identity: {
					email: subscriber.email_address,
					name: subscriber.first_name,
					via: 'cookie',
				},
				subscriber,
			})
		},
	)

	it('preserves cookie-only identity without treating it as signed in', async () => {
		const result = await resolveEnrolmentIdentity()
		expect(result).toEqual({
			identity: {
				email: subscriber.email_address,
				name: subscriber.first_name,
				via: 'cookie',
			},
			subscriber,
		})
		expect(await isSignedInAs(result.identity!)).toBe(false)
	})

	it('still uses the cookie if session lookup fails', async () => {
		mocks.getServerAuthSession.mockRejectedValue(new Error('Auth unavailable'))
		expect(await resolveEnrolmentIdentity()).toMatchObject({
			identity: { email: subscriber.email_address, via: 'cookie' },
			subscriber,
		})
	})

	it.each(['absent', 'unreadable'])(
		'uses the session with an %s cookie',
		async (cookie) => {
			signIn('new@example.test')
			if (cookie === 'unreadable') {
				mocks.getSubscriberFromCookie.mockRejectedValue(new Error('Bad cookie'))
			} else {
				mocks.getSubscriberFromCookie.mockResolvedValue(null)
			}
			expect(await resolveEnrolmentIdentity()).toMatchObject({
				identity: { email: 'new@example.test', via: 'session' },
				subscriber: null,
			})
		},
	)

	it('returns no identity when neither source identifies the reader', async () => {
		mocks.getSubscriberFromCookie.mockResolvedValue(null)
		expect(await resolveEnrolmentIdentity()).toEqual({
			identity: null,
			subscriber: null,
		})
	})
})
