import { readMagicLinkFragment } from '@/server/magic-link-fragment'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	adapterFindOrCreateUser: vi.fn(),
	getUserByEmail: vi.fn(),
	validate: vi.fn(),
	info: vi.fn(),
	env: {
		POSTMARK_API_KEY: 'pm',
		NEXT_PUBLIC_SUPPORT_EMAIL: 'team@example.test',
		AIH_EMAIL_VALIDATION_ENABLED: undefined as string | undefined,
	},
	findOrCreateUserWithPersonalOrg: vi.fn(),
	sendVerificationRequest: vi.fn(),
}))

vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		getUserByEmail: mocks.getUserByEmail,
		findOrCreateUser: mocks.adapterFindOrCreateUser,
	},
}))
vi.mock('@/env.mjs', () => ({
	env: mocks.env,
}))
vi.mock('@/lib/subscriber-marketing/drovr-email-validation', () => ({
	validateEmailWithDrovr: mocks.validate,
}))
vi.mock('@/server/logger', () => ({ log: { info: mocks.info } }))
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

import {
	emailProvider,
	EmailRejectedError,
	loginEmailProvider,
	magicLinkIdentity,
} from './email-provider'

beforeEach(() => {
	vi.clearAllMocks()
	mocks.env.AIH_EMAIL_VALIDATION_ENABLED = undefined
	mocks.getUserByEmail.mockResolvedValue(null)
	mocks.validate.mockResolvedValue({
		verdict: 'accept',
		policyVersion: 'test-policy',
	})
	mocks.info.mockResolvedValue(undefined)
})

describe('email validation gate', () => {
	it.each([
		undefined,
		'another@other.example.test',
		'person@other.example.test@invalid',
		'person@<script>.test',
	])(
		'keeps unsafe or non-domain suggestions out of the public code: %s',
		(suggestion) => {
			expect(
				new EmailRejectedError('person@example.test', suggestion).code,
			).toBe('EmailRejected')
		},
	)
	const send = async () =>
		emailProvider.options!.sendVerificationRequest!({
			identifier: 'person@example.test',
			url: 'https://www.aihero.dev/api/auth/callback/postmark?token=test&email=person%40example.test',
		} as any)
	it('resolves drovr like the other clients when only the shadow ingest URL is set', async () => {
		Object.assign(mocks.env, {
			AIH_EMAIL_VALIDATION_ENABLED: 'true',
			DROVR_SHADOW_INGEST_URL: 'https://drovr.example.test/shadow/ingest',
			DROVR_API_KEY_ORG_AIHERO: 'tenant-key',
		})
		try {
			await send()
			expect(mocks.validate).toHaveBeenCalledWith('person@example.test', {
				baseUrl: 'https://drovr.example.test',
				apiKey: 'tenant-key',
			})
		} finally {
			delete (mocks.env as Record<string, unknown>).DROVR_SHADOW_INGEST_URL
			delete (mocks.env as Record<string, unknown>).DROVR_API_KEY_ORG_AIHERO
		}
	})
	it('blocks a new rejected email before identity creation or sending', async () => {
		mocks.env.AIH_EMAIL_VALIDATION_ENABLED = 'true'
		mocks.validate.mockResolvedValue({
			verdict: 'reject',
			reason: 'disposable_domain',
			suggestion: 'person@other.example.test',
			policyVersion: 'test-policy',
		})
		const error = await send().catch((error) => error)
		expect(error.type).toBe('CredentialsSignin')
		expect(error.code).toBe('EmailRejected:other.example.test')
		expect(error.kind).toBe('error')
		expect(mocks.sendVerificationRequest).not.toHaveBeenCalled()
		expect(mocks.findOrCreateUserWithPersonalOrg).not.toHaveBeenCalled()
		expect(mocks.info).toHaveBeenCalledWith(
			'auth.email_validation.checked',
			expect.objectContaining({
				verdict: 'reject',
				reason: 'disposable_domain',
				policyVersion: 'test-policy',
				ms: expect.any(Number),
			}),
		)
		expect(mocks.info).toHaveBeenCalledWith(
			'auth.email_validation.blocked',
			expect.any(Object),
		)
		expect(JSON.stringify(mocks.info.mock.calls)).not.toContain('person@')
	})
	it.each(['accept', 'unknown'])('continues for %s', async (verdict) => {
		mocks.env.AIH_EMAIL_VALIDATION_ENABLED = 'true'
		mocks.validate.mockResolvedValue({ verdict })
		await send()
		expect(mocks.sendVerificationRequest).toHaveBeenCalledOnce()
	})
	it.each([
		{
			verdict: 'reject',
			reason: 'disposable_domain',
			policyVersion: 'test-policy',
		},
		{ verdict: 'unknown', error: 'timeout' },
		{ verdict: 'unknown', error: 'request_failed' },
	])('ignores $verdict/$error for existing users', async (result) => {
		mocks.env.AIH_EMAIL_VALIDATION_ENABLED = 'true'
		mocks.getUserByEmail.mockResolvedValue({ id: 'u1' })
		mocks.validate.mockResolvedValue(result)
		await send()
		expect(mocks.validate).toHaveBeenCalledOnce()
		expect(mocks.sendVerificationRequest).toHaveBeenCalledOnce()
		expect(mocks.info).not.toHaveBeenCalled()
	})
	it.each([null, { id: 'u1' }])(
		'starts both reads together and awaits validation for user %j',
		async (user) => {
			mocks.env.AIH_EMAIL_VALIDATION_ENABLED = 'true'
			let resolveUser!: (value: unknown) => void
			let resolveValidation!: (value: unknown) => void
			mocks.getUserByEmail.mockReturnValue(
				new Promise((resolve) => {
					resolveUser = resolve
				}),
			)
			mocks.validate.mockReturnValue(
				new Promise((resolve) => {
					resolveValidation = resolve
				}),
			)
			const pending = send()
			expect(mocks.getUserByEmail).toHaveBeenCalledOnce()
			expect(mocks.validate).toHaveBeenCalledOnce()
			resolveUser(user)
			await Promise.resolve()
			expect(mocks.sendVerificationRequest).not.toHaveBeenCalled()
			resolveValidation({ verdict: 'accept', policyVersion: 'test-policy' })
			await pending
			expect(mocks.sendVerificationRequest).toHaveBeenCalledOnce()
			expect(mocks.info).toHaveBeenCalledTimes(user ? 0 : 1)
		},
	)
	it.each([undefined, 'false', 'TRUE'])(
		'skips when flag is %s',
		async (flag) => {
			mocks.env.AIH_EMAIL_VALIDATION_ENABLED = flag
			await send()
			expect(mocks.getUserByEmail).not.toHaveBeenCalled()
			expect(mocks.validate).not.toHaveBeenCalled()
			expect(mocks.sendVerificationRequest).toHaveBeenCalledOnce()
		},
	)
})

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
