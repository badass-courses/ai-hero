import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import {
	MAGIC_LINK_COOKIE_NAME,
	createMagicLinkConfirmHandler,
	createMagicLinkGetHandler,
} from './magic-link-confirmation'

import { Auth } from '@auth/core'
import type {
	Adapter,
	AdapterSession,
	AdapterUser,
	VerificationToken,
} from '@auth/core/adapters'
import Postmark from '@auth/core/providers/postmark'

const secret = 'magic-link-reproduction-secret'
const email = 'learner@example.com'
const rawToken = 'scanner-prefetched-token'
const callbackUrl = 'https://www.aihero.dev/welcome'

function hashVerificationToken(token: string) {
	return createHash('sha256').update(`${token}${secret}`).digest('hex')
}

function createHarness() {
	const user: AdapterUser = {
		id: 'learner',
		email,
		emailVerified: null,
		roles: [],
		entitlements: [],
	}
	let verificationToken: VerificationToken | null = {
		identifier: email,
		token: hashVerificationToken(rawToken),
		expires: new Date(Date.now() + 60_000),
	}
	const useVerificationToken = vi.fn(
		async (candidate: { identifier: string; token: string }) => {
			if (
				verificationToken?.identifier !== candidate.identifier ||
				verificationToken.token !== candidate.token
			) {
				return null
			}
			const consumed = verificationToken
			verificationToken = null
			return consumed
		},
	)
	const adapter: Adapter = {
		createUser: vi.fn(async (data) => ({
			...data,
			id: 'created',
			roles: data.roles ?? [],
			entitlements: data.entitlements ?? [],
		})),
		getUser: vi.fn(async () => user),
		getUserByEmail: vi.fn(async () => user),
		getUserByAccount: vi.fn(async () => null),
		updateUser: vi.fn(async (data) => ({ ...user, ...data })),
		deleteUser: vi.fn(async () => undefined),
		linkAccount: vi.fn(async () => undefined),
		unlinkAccount: vi.fn(async () => undefined),
		createSession: vi.fn(
			async (session): Promise<AdapterSession> => session,
		),
		getSessionAndUser: vi.fn(async () => null),
		updateSession: vi.fn(async () => null),
		deleteSession: vi.fn(async () => undefined),
		createVerificationToken: vi.fn(async (token) => token),
		useVerificationToken,
	}
	return { adapter, useVerificationToken }
}

function callbackRequest(method: 'GET' | 'POST' = 'GET') {
	const url = new URL('/api/auth/callback/postmark', 'https://www.aihero.dev')
	url.searchParams.set('callbackUrl', callbackUrl)
	url.searchParams.set('token', rawToken)
	url.searchParams.set('email', email)
	return new Request(url, { method })
}

async function runAuthRequest(adapter: Adapter, request: Request) {
	return Auth(request, {
		adapter,
		basePath: '/api/auth',
		providers: [
			Postmark({
				apiKey: 'test-postmark-key',
				from: 'support@example.com',
			}),
		],
		secret,
		trustHost: true,
		pages: { error: '/error' },
	})
}

async function runCallback(adapter: Adapter) {
	return runAuthRequest(adapter, callbackRequest())
}

function confirmationCookie(response: Response) {
	const pair = response.headers.get('set-cookie')!.split(';', 1)[0]!
	return pair.slice(pair.indexOf('=') + 1)
}

describe('Auth.js magic-link callback reproduction', () => {
	it('lets a scanner GET consume the token before the customer GET', async () => {
		const { adapter, useVerificationToken } = createHarness()

		const scannerResponse = await runCallback(adapter)
		const customerResponse = await runCallback(adapter)

		expect(scannerResponse.status).toBe(302)
		expect(scannerResponse.headers.get('location')).toBe(callbackUrl)
		expect(customerResponse.status).toBe(302)
		expect(customerResponse.headers.get('location')).toContain(
			'/error?error=Verification',
		)
		expect(useVerificationToken).toHaveBeenCalledTimes(2)
	})

	it('uses the query-free confirmation route to reach Auth.js once', async () => {
		const { adapter, useVerificationToken } = createHarness()
		const now = Date.now()
		const initialResponse = await createMagicLinkGetHandler(vi.fn(), {
			secret,
			now,
		})(callbackRequest())
		const confirm = createMagicLinkConfirmHandler(
			(request) => runAuthRequest(adapter, request),
			{ secret, now },
		)

		const response = await confirm(
			new Request('https://www.aihero.dev/api/auth/magic-link/confirm', {
				method: 'POST',
				headers: {
					cookie: `${MAGIC_LINK_COOKIE_NAME}=${confirmationCookie(initialResponse)}`,
				},
			}),
		)
		const missingCookieResponse = await confirm(
			new Request('https://www.aihero.dev/api/auth/magic-link/confirm', {
				method: 'POST',
			}),
		)

		expect(response.status).toBe(302)
		expect(response.headers.get('location')).toBe(callbackUrl)
		expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
		expect(missingCookieResponse.status).toBe(303)
		expect(useVerificationToken).toHaveBeenCalledOnce()
	})
})
