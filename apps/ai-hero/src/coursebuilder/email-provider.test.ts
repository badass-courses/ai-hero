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
	env: { POSTMARK_API_KEY: 'pm', NEXT_PUBLIC_SUPPORT_EMAIL: 'team@example.test' },
}))
vi.mock('@/lib/find-or-create-user', () => ({
	findOrCreateUserWithPersonalOrg: mocks.findOrCreateUserWithPersonalOrg,
}))
vi.mock('@coursebuilder/email/send-verification-request', () => ({
	sendVerificationRequest: mocks.sendVerificationRequest,
}))
vi.mock('next-auth/providers/postmark', () => ({
	default: (options: unknown) => ({ id: 'postmark', options }),
}))

import { readMagicLinkFragment } from '@/server/magic-link-fragment'

import { emailProvider, magicLinkIdentity } from './email-provider'

describe('magic-link identity port', () => {
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
