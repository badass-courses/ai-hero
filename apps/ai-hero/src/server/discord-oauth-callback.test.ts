import { createSign, generateKeyPairSync } from 'node:crypto'
import { Auth, customFetch, skipCSRFCheck, type AuthConfig } from '@auth/core'
import type { Adapter, AdapterUser } from '@auth/core/adapters'
import Discord from '@auth/core/providers/discord'
import { describe, expect, it, vi } from 'vitest'

import {
	createOAuthContainmentAdapter,
	createOAuthContainmentSignInCallback,
	runWithOAuthContainmentRequest,
	takeVerifiedOAuthLink,
} from './oauth-link-containment'
import { createAuthenticatedOAuthLinkSessionResolver } from './oauth-link-session'
import { getDiscordProviderConfig } from './oauth-provider-config'

const origin = 'https://app.example.com'
const clientId = 'discord-test-client'
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })

// Discord can include an ID token even for an OAuth (not OIDC) provider.
function discordIdToken(issuer: string) {
	const now = Math.floor(Date.now() / 1000)
	const payload = [
		{ alg: 'RS256', typ: 'JWT' },
		{
			iss: issuer,
			aud: clientId,
			sub: 'discord-account',
			iat: now,
			exp: now + 300,
		},
	]
		.map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
		.join('.')
	const signature = createSign('RSA-SHA256')
		.update(payload)
		.sign(privateKey, 'base64url')
	return `${payload}.${signature}`
}

async function runDiscordCallback({
	omitIssuer = false,
	tokenIssuer = 'https://discord.com',
	includeIdToken = true,
	hasSession = true,
	conflictingOwner = false,
} = {}) {
	const user: AdapterUser = {
		id: 'learner',
		email: 'learner@example.com',
		emailVerified: null,
		roles: [],
		entitlements: [],
	}
	let owner: AdapterUser | null = null
	const session = {
		sessionToken: 'test-session',
		userId: user.id,
		expires: new Date(Date.now() + 60_000),
	}
	const cookieValues = new Map<string, string>([
		['__Host-aih-oauth-link-intent', 'test-link-intent'],
		...(hasSession
			? [['__Secure-authjs.session-token', session.sessionToken] as const]
			: []),
	])
	const cookieStore = {
		get: (name: string) => {
			const value = cookieValues.get(name)
			return value ? { value } : undefined
		},
		delete: (name: string) => cookieValues.delete(name),
	}
	const getSessionAndUser = vi.fn(async () =>
		hasSession ? { user, session } : null,
	)
	const linkAccount = vi.fn()
	const createUser = vi.fn()
	const adapter = createOAuthContainmentAdapter({
		getUser: vi.fn(async () => user),
		getUserByEmail: vi.fn(async () => null),
		getUserByAccount: vi.fn(async () => owner),
		getSessionAndUser,
		createSession: vi.fn(async (value) => value),
		createUser,
		updateUser: vi.fn(),
		updateSession: vi.fn(),
		deleteSession: vi.fn(),
		linkAccount,
	} satisfies Adapter)
	const consumeLinkIntent = vi.fn(async () => {
		if (conflictingOwner) {
			return {
				status: 'denied' as const,
				reasonClass: 'cross-user-owned' as const,
			}
		}
		owner = user
		return {
			status: 'linked' as const,
			targetUserId: user.id,
			linkKind: 'created' as const,
			flowId: 'test-flow',
		}
	})
	const observe = vi.fn()
	const error = vi.fn()
	const signIn = vi.fn(async ({ user }: { user: { id?: string } }) => {
		if (!user.id) throw new Error('Expected a persisted user')
		expect(takeVerifiedOAuthLink(user.id)).toMatchObject({
			targetUserId: user.id,
		})
	})
	const provider = getDiscordProviderConfig({
		clientId,
		clientSecret: 'test-secret',
	})
	const fetchDiscord = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input)
		if (url === 'https://discord.com/api/oauth2/token') {
			return Response.json({
				access_token: 'test-access-token',
				token_type: 'Bearer',
				expires_in: 3600,
				...(includeIdToken ? { id_token: discordIdToken(tokenIssuer) } : {}),
			})
		}
		if (url === 'https://discord.com/api/users/@me') {
			return Response.json({
				id: 'discord-account',
				username: 'learner',
				email: user.email,
				avatar: 'test-avatar',
				discriminator: '0',
			})
		}
		throw new Error(`Unexpected OAuth fetch: ${url}`)
	})
	const config: AuthConfig = {
		adapter,
		basePath: '/api/auth',
		secret: 'discord-callback-test-secret',
		trustHost: true,
		// The app starts this request through next-auth's server-side signIn,
		// which also passes skipCSRFCheck. OAuth PKCE checks remain enabled.
		skipCSRFCheck,
		pages: { error: '/error' },
		logger: { error, warn: vi.fn(), debug: vi.fn() },
		providers: [
			Discord({
				...provider,
				...(omitIssuer ? { issuer: undefined } : {}),
				[customFetch]: fetchDiscord,
			}),
		],
		callbacks: {
			signIn: createOAuthContainmentSignInCallback({
				getCookieStore: () => cookieStore,
				findAccountOwner: async () => owner,
				getAuthenticatedSession: createAuthenticatedOAuthLinkSessionResolver({
					getCookieStore: () => cookieStore,
					getSessionAndUser,
				}),
				consumeLinkIntent,
				observe,
			}),
		},
		events: { signIn },
	}
	const start = new Request(`${origin}/api/auth/signin/discord`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ callbackUrl: `${origin}/discord/redirect` }),
	})
	const authorization = await runWithOAuthContainmentRequest(start, () =>
		Auth(start, config),
	)
	expect(error).not.toHaveBeenCalled()
	expect(authorization.headers.get('location')).toContain(
		'https://discord.com/api/oauth2/authorize',
	)
	expect(
		new URL(authorization.headers.get('location')!).searchParams.get(
			'code_challenge_method',
		),
	).toBe('S256')
	for (const cookie of authorization.headers.getSetCookie()) {
		const pair = cookie.split(';')[0]!
		const equals = pair.indexOf('=')
		cookieValues.set(pair.slice(0, equals), pair.slice(equals + 1))
	}
	const request = new Request(
		`${origin}/api/auth/callback/discord?code=test-code`,
		{
			headers: {
				cookie: [...cookieValues]
					.map(([name, value]) => `${name}=${value}`)
					.join('; '),
			},
		},
	)
	const response = await runWithOAuthContainmentRequest(request, () =>
		Auth(request, config),
	)
	return {
		response,
		observe,
		error,
		consumeLinkIntent,
		signIn,
		linkAccount,
		createUser,
	}
}

describe('Discord callback through installed Auth.js', () => {
	it('reproduces Configuration before containment when the issuer is omitted', async () => {
		const result = await runDiscordCallback({ omitIssuer: true })
		expect(result.response.headers.get('location')).toBe(
			`${origin}/error?error=Configuration`,
		)
		expect(result.error).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'CallbackRouteError',
				cause: expect.objectContaining({
					err: expect.objectContaining({
						message: 'unexpected JWT "iss" (issuer) claim value',
					}),
				}),
			}),
		)
		expect(result.observe).not.toHaveBeenCalled()
		expect(result.consumeLinkIntent).not.toHaveBeenCalled()
		expect(result.linkAccount).not.toHaveBeenCalled()
		expect(result.createUser).not.toHaveBeenCalled()
	})

	it.each([true, false])(
		'links with a session-bound intent (ID token: %s)',
		async (includeIdToken) => {
			const result = await runDiscordCallback({ includeIdToken })
			expect(result.response.headers.get('location')).toBe(
				`${origin}/discord/redirect`,
			)
			expect(result.error).not.toHaveBeenCalled()
			expect(result.observe).toHaveBeenCalledWith(
				expect.objectContaining({ action: 'callback_received' }),
			)
			expect(result.consumeLinkIntent).toHaveBeenCalledOnce()
			expect(result.signIn).toHaveBeenCalledOnce()
			expect(result.linkAccount).not.toHaveBeenCalled()
			expect(result.createUser).not.toHaveBeenCalled()
		},
	)

	it('still rejects an ID token from another issuer before linking', async () => {
		const result = await runDiscordCallback({
			tokenIssuer: 'https://attacker.example',
		})
		expect(result.response.headers.get('location')).toBe(
			`${origin}/error?error=Configuration`,
		)
		expect(result.consumeLinkIntent).not.toHaveBeenCalled()
		expect(result.signIn).not.toHaveBeenCalled()
		expect(result.linkAccount).not.toHaveBeenCalled()
		expect(result.createUser).not.toHaveBeenCalled()
	})

	it.each([
		{ hasSession: false, path: '/discord?link=denied' },
		{ conflictingOwner: true, path: '/discord?link=account-conflict' },
	])('keeps the safe denial redirect $path', async ({ path, ...options }) => {
		const result = await runDiscordCallback(options)
		expect(result.response.headers.get('location')).toBe(`${origin}${path}`)
		expect(result.error).not.toHaveBeenCalled()
		expect(result.signIn).not.toHaveBeenCalled()
		expect(result.linkAccount).not.toHaveBeenCalled()
		expect(result.createUser).not.toHaveBeenCalled()
		if (options.hasSession === false)
			expect(result.consumeLinkIntent).not.toHaveBeenCalled()
	})
})
