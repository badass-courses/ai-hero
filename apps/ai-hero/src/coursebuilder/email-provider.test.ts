import { readMagicLinkFragment } from '@/server/magic-link-fragment'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	adapterFindOrCreateUser: vi.fn(),
	findOrCreateUserWithPersonalOrg: vi.fn(),
	sendVerificationRequest: vi.fn(),
}))

vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		getUserByEmail: vi.fn(),
		findOrCreateUser: mocks.adapterFindOrCreateUser,
	},
}))
vi.mock('@/env.mjs', () => ({
	env: {
		POSTMARK_API_KEY: 'pm',
		NEXT_PUBLIC_SUPPORT_EMAIL: 'team@example.test',
	},
}))
vi.mock('@/lib/find-or-create-user', () => ({
	findOrCreateUserWithPersonalOrg: mocks.findOrCreateUserWithPersonalOrg,
}))
vi.mock('@coursebuilder/email/send-verification-request', () => {
	class PostmarkSendError extends Error {
		readonly status?: number
		readonly postmarkErrorCode?: number
		constructor(options: { status?: number; postmarkErrorCode?: number }) {
			super(`Postmark request failed with status ${options.status}`)
			this.status = options.status
			this.postmarkErrorCode = options.postmarkErrorCode
			this.name = 'PostmarkSendError'
		}
	}
	return {
		PostmarkSendError,
		sendVerificationRequest: mocks.sendVerificationRequest,
	}
})
vi.mock('next-auth/providers/postmark', () => ({
	default: (options: unknown) => ({ id: 'postmark', options }),
}))

import { PostmarkSendError } from '@coursebuilder/email/send-verification-request'

import { emailProvider, loginEmailProvider, magicLinkIdentity } from './email-provider'

describe('magic-link identity port', () => {
	it('limits requested login links to one hour without shortening buyer emails', () => {
		expect(loginEmailProvider.maxAge).toBe(3600)
		expect(loginEmailProvider.options.maxAge).toBe(3600)
		expect(emailProvider.options?.maxAge).toBe(86400)
		expect(loginEmailProvider.options.sendVerificationRequest).toBe(
			emailProvider.options?.sendVerificationRequest,
		)
	})

	it('mints first-time recipients through the personal-org boundary', async () => {
		mocks.findOrCreateUserWithPersonalOrg.mockResolvedValue({
			user: { id: 'u1', email: 'new@example.test' },
			isNewUser: true,
		})

		const result = await magicLinkIdentity.findOrCreateUser('new@example.test')

		expect(result.user.id).toBe('u1')
		expect(mocks.findOrCreateUserWithPersonalOrg).toHaveBeenCalledWith(
			'new@example.test',
			undefined,
		)
		expect(mocks.adapterFindOrCreateUser).not.toHaveBeenCalled()
	})

	it('hands that port to sendVerificationRequest', async () => {
		const options = (emailProvider as unknown as { options: { sendVerificationRequest: (p: unknown) => Promise<void> } }).options
		const params = {
			identifier: 'new@example.test',
			url: 'https://www.aihero.dev/api/auth/callback/postmark?callbackUrl=https%3A%2F%2Fwww.aihero.dev%2Fwelcome&token=one-time-token&email=new%40example.test',
		}

		await options.sendVerificationRequest(params)

		expect(mocks.sendVerificationRequest).toHaveBeenCalledWith(
			expect.objectContaining({ identifier: 'new@example.test' }),
			magicLinkIdentity,
		)
	})

	it('emails a fragment link with no secrets in the query string', async () => {
		mocks.sendVerificationRequest.mockClear()
		const options = (emailProvider as unknown as { options: { sendVerificationRequest: (p: unknown) => Promise<void> } }).options

		await options.sendVerificationRequest({
			identifier: 'new@example.test',
			url: 'https://www.aihero.dev/api/auth/callback/postmark?callbackUrl=https%3A%2F%2Fwww.aihero.dev%2Fwelcome&token=one-time-token&email=new%40example.test',
		})

		const sent = new URL(
			mocks.sendVerificationRequest.mock.calls[0]![0].url as string,
		)
		expect(sent.pathname).toBe('/login/verify')
		expect(sent.search).toBe('')
		expect(sent.toString()).not.toMatch(/\?[^#]*(token|email|callbackUrl)=/)
		expect(readMagicLinkFragment(sent.hash)).toEqual({
			token: 'one-time-token',
			email: 'new@example.test',
			callbackUrl: 'https://www.aihero.dev/welcome',
		})
	})
})

describe('inactive recipient', () => {
	type Provider = {
		options: { sendVerificationRequest: (p: unknown) => Promise<void> }
	}
	const send = () =>
		(emailProvider as unknown as Provider).options.sendVerificationRequest({
			identifier: 'person@example.test',
			url: 'https://www.aihero.dev/api/auth/callback/postmark?token=one-time-token&email=person%40example.test',
		})

	it('turns Postmark ErrorCode 406 into a client-safe CredentialsSignin on the error page', async () => {
		mocks.sendVerificationRequest.mockRejectedValueOnce(
			new PostmarkSendError({ status: 422, postmarkErrorCode: 406 }),
		)

		const error: any = await send().catch((e) => e)

		expect(error.type).toBe('CredentialsSignin')
		expect(error.code).toBe('EmailInactive')
		expect(error.kind).toBe('error')
		expect(JSON.stringify([error.message, error.code])).not.toContain('person@')
	})

	it('leaves other Postmark failures as they were', async () => {
		mocks.sendVerificationRequest.mockRejectedValueOnce(
			new PostmarkSendError({ status: 422, postmarkErrorCode: 300 }),
		)

		const error: any = await send().catch((e) => e)

		expect(error.message).toBe('Postmark request failed with status 422')
		expect(error.code).toBeUndefined()
	})

	it('finds a 406 PostmarkSendError wrapped as a cause', async () => {
		mocks.sendVerificationRequest.mockRejectedValueOnce(
			new Error('wrapped', {
				cause: new PostmarkSendError({ status: 422, postmarkErrorCode: 406 }),
			}),
		)

		const error: any = await send().catch((e) => e)

		expect(error.code).toBe('EmailInactive')
	})

	it('leaves non-Postmark failures as they were', async () => {
		mocks.sendVerificationRequest.mockRejectedValueOnce(new Error('boom'))

		await expect(send()).rejects.toThrow('boom')
	})
})
