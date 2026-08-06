import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	clearLegacyOAuthLinkCookies,
	legacyOAuthLinkCookieNames,
} from '@/lib/oauth-link-cookie'

import type { Adapter } from '@auth/core/adapters'

import { handleLoginOrRegister } from '../../node_modules/@auth/core/lib/actions/callback/handle-login.js'
import { createPostSignInInvitationHandler } from './auth-post-sign-in'
import {
	assertOAuthLinkAccountEventUnreachableDuringContainment,
	createOAuthContainmentAdapter,
	createOAuthContainmentSignInCallback,
	runWithOAuthContainmentRequest,
} from './oauth-link-containment'
import {
	getDiscordProviderConfig,
	getGithubProviderConfig,
} from './oauth-provider-config'

const authSource = readFileSync(new URL('./auth.ts', import.meta.url), 'utf8')

type Provider = 'github' | 'discord'

function createCookieStore() {
	return { delete: vi.fn() }
}

function authCallbackRequest(provider: string) {
	return new Request(`https://www.aihero.dev/api/auth/callback/${provider}`)
}

function createLockedAuthHarness({
	provider,
	accountOwner,
	activeUser = null,
	accountType = 'oauth',
}: {
	provider: string
	accountOwner: { id: string; email: string } | null
	activeUser?: { id: string; email: string } | null
	accountType?: 'oauth' | 'email'
}) {
	let currentAccountOwner = accountOwner
	const account = {
		type: accountType,
		provider,
		providerAccountId: `${provider}-account`,
		access_token: 'must-not-be-emitted',
	}
	const profile = {
		id: `${provider}-profile`,
		email: accountOwner?.email ?? `${provider}@example.com`,
		name: 'Provider User',
		image: null,
	}
	const session = activeUser
		? {
			sessionToken: 'active-session',
			userId: activeUser.id,
			expires: new Date('2026-09-01T00:00:00Z'),
		}
		: null
	const linkAccount = vi.fn()
	const createUserEvent = vi.fn()
	const linkAccountEvent = vi.fn()
	const createUser = vi.fn(async (user) => ({ id: 'new-user', ...user }))
	const createSession = vi.fn(async (value) => value)
	const getUserByAccount = vi.fn(async () => currentAccountOwner)
	const findAccountOwner = vi.fn(async () => currentAccountOwner)
	const providerCall = vi.fn((tokens: Record<string, unknown>) => tokens)

	const adapter = createOAuthContainmentAdapter({
		createUser,
		updateUser: vi.fn(),
		getUser: vi.fn(async (id) => (activeUser?.id === id ? activeUser : null)),
		getUserByAccount,
		getUserByEmail: vi.fn(async () => null),
		linkAccount,
		createSession,
		getSessionAndUser: vi.fn(async () =>
			activeUser && session ? { user: activeUser, session } : null,
		),
		deleteSession: vi.fn(),
	} as unknown as Adapter)

	const options = {
		adapter,
		cookies: { sessionToken: { name: 'authjs.session-token' } },
		events: {
			createUser: createUserEvent,
			linkAccount: linkAccountEvent,
		},
		jwt: { decode: vi.fn() },
		provider: {
			id: provider,
			name: provider,
			type: accountType,
			account: providerCall,
		},
		session: {
			strategy: 'database',
			generateSessionToken: () => 'new-session',
			maxAge: 30 * 24 * 60 * 60,
		},
	}

	return {
		account,
		adapter,
		findAccountOwner,
		profile,
		options,
		setAccountOwner: (owner: { id: string; email: string } | null) => {
			currentAccountOwner = owner
		},
		calls: {
			createSession,
			createUser,
			createUserEvent,
			getUserByAccount,
			linkAccount,
			linkAccountEvent,
			providerCall,
		},
	}
}

describe('Auth.js OAuth containment policy', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it.each<Provider>(['github', 'discord'])(
		'allows an established %s account through locked Auth.js',
		async (provider) => {
			const owner = { id: 'owner', email: 'owner@example.com' }
			const harness = createLockedAuthHarness({ provider, accountOwner: owner })
			const callback = createOAuthContainmentSignInCallback({
				getCookieStore: createCookieStore,
				findAccountOwner: harness.findAccountOwner,
			})

			const result = await runWithOAuthContainmentRequest(
				authCallbackRequest(provider),
				async () => {
					await expect(
						harness.adapter.getUserByAccount?.(harness.account),
					).resolves.toMatchObject({ id: owner.id })
					await expect(callback({ account: harness.account })).resolves.toBe(true)
					return handleLoginOrRegister(
						'',
						harness.profile,
						harness.account,
						harness.options as never,
					)
				},
			)

			expect(result.user.id).toBe(owner.id)
			expect(harness.calls.createSession).toHaveBeenCalledOnce()
			expect(harness.calls.linkAccount).not.toHaveBeenCalled()
			expect(harness.calls.linkAccountEvent).not.toHaveBeenCalled()
			expect(harness.calls.createUser).not.toHaveBeenCalled()
	})

	it.each([
		{ provider: 'github' as const, sessionToken: 'active-session' },
		{ provider: 'discord' as const, sessionToken: '' },
	])(
		'blocks the $provider ownership race before locked Auth.js mutates',
		async ({ provider, sessionToken }) => {
			const owner = { id: 'owner', email: 'owner@example.com' }
			const invitationAcceptance = vi.fn()
			const harness = createLockedAuthHarness({
				provider,
				accountOwner: owner,
				activeUser: sessionToken ? owner : null,
			})
			const callback = createOAuthContainmentSignInCallback({
				getCookieStore: createCookieStore,
				findAccountOwner: harness.findAccountOwner,
			})

			await expect(
				runWithOAuthContainmentRequest(
					authCallbackRequest(provider),
					async () => {
						await expect(
							harness.adapter.getUserByAccount?.(harness.account),
						).resolves.toMatchObject({ id: owner.id })
						await expect(callback({ account: harness.account })).resolves.toBe(
							true,
						)
						harness.setAccountOwner(null)
						const result = await handleLoginOrRegister(
							sessionToken,
							harness.profile,
							harness.account,
							harness.options as never,
						)
						await invitationAcceptance(result.user)
						return result
					},
				),
			).rejects.toThrow('OAuth containment')

			for (const mutationOrEvent of [
				harness.calls.createUser,
				harness.calls.createUserEvent,
				harness.calls.linkAccount,
				harness.calls.linkAccountEvent,
				harness.calls.createSession,
				invitationAcceptance,
				harness.calls.providerCall,
			]) {
				expect(mutationOrEvent).not.toHaveBeenCalled()
			}
		},
	)

	it.each<Provider>(['github', 'discord'])(
		'denies an unowned %s account before downstream work',
		async (provider) => {
			const downstream = {
				accountMutation: vi.fn(),
				invitationAcceptance: vi.fn(),
				inngest: vi.fn(),
				discord: vi.fn(),
				provider: vi.fn(),
			}
			const callback = createOAuthContainmentSignInCallback({
				getCookieStore: createCookieStore,
				findAccountOwner: vi.fn(async () => null),
			})

			const allowed = await runWithOAuthContainmentRequest(
				authCallbackRequest(provider),
				() =>
					callback({
						account: {
							provider,
							providerAccountId: `${provider}-unowned`,
						},
					}),
			)
			if (allowed) {
				for (const work of Object.values(downstream)) work()
			}

			expect(allowed).toBe(false)
			for (const work of Object.values(downstream)) {
				expect(work).not.toHaveBeenCalled()
			}
		},
	)

	it('fails closed when the ownership lookup errors', async () => {
		const callback = createOAuthContainmentSignInCallback({
			getCookieStore: createCookieStore,
			findAccountOwner: vi.fn(async () => {
				throw new Error('database unavailable')
			}),
		})

		await expect(
			runWithOAuthContainmentRequest(
				authCallbackRequest('github'),
				() =>
					callback({
						account: {
							provider: 'github',
							providerAccountId: 'github-account',
						},
					}),
			),
		).resolves.toBe(false)
	})

	it('leaves a cross-owner account unchanged in locked Auth.js', async () => {
		const alice = { id: 'alice', email: 'alice@example.com' }
		const bob = { id: 'bob', email: 'bob@example.com' }
		const harness = createLockedAuthHarness({
			provider: 'github',
			accountOwner: bob,
			activeUser: alice,
		})
		const callback = createOAuthContainmentSignInCallback({
			getCookieStore: createCookieStore,
			findAccountOwner: harness.findAccountOwner,
		})

		await expect(
			runWithOAuthContainmentRequest(
				authCallbackRequest('github'),
				async () => {
					await callback({ account: harness.account })
					return handleLoginOrRegister(
						'active-session',
						harness.profile,
						harness.account,
						harness.options as never,
					)
				},
			),
		).rejects.toMatchObject({ type: 'OAuthAccountNotLinked' })
		expect(harness.calls.linkAccount).not.toHaveBeenCalled()
		expect(harness.calls.linkAccountEvent).not.toHaveBeenCalled()
		expect(harness.calls.createUser).not.toHaveBeenCalled()
		expect(harness.calls.getUserByAccount).toHaveBeenCalledOnce()
		expect(bob).toEqual({ id: 'bob', email: 'bob@example.com' })
	})

	it('leaves email magic-link user creation unchanged in locked Auth.js', async () => {
		const harness = createLockedAuthHarness({
			provider: 'postmark',
			accountOwner: null,
			accountType: 'email',
		})
		const callback = createOAuthContainmentSignInCallback({
			getCookieStore: createCookieStore,
			findAccountOwner: vi.fn(),
		})

		const result = await runWithOAuthContainmentRequest(
			authCallbackRequest('postmark'),
			async () => {
				await expect(callback({ account: harness.account })).resolves.toBe(true)
				return handleLoginOrRegister(
					'',
					harness.profile,
					harness.account,
					harness.options as never,
				)
			},
		)

		expect(result.isNewUser).toBe(true)
		expect(harness.calls.createUser).toHaveBeenCalledOnce()
		expect(harness.calls.createUserEvent).toHaveBeenCalledOnce()
		expect(harness.calls.createSession).toHaveBeenCalledOnce()
		expect(harness.calls.linkAccount).not.toHaveBeenCalled()
	})

	it('isolates concurrent contained OAuth and email callback guards', async () => {
		const owner = { id: 'owner', email: 'owner@example.com' }
		const oauthHarness = createLockedAuthHarness({
			provider: 'github',
			accountOwner: owner,
		})
		const emailHarness = createLockedAuthHarness({
			provider: 'postmark',
			accountOwner: null,
			accountType: 'email',
		})
		const oauthCallback = createOAuthContainmentSignInCallback({
			getCookieStore: createCookieStore,
			findAccountOwner: oauthHarness.findAccountOwner,
		})
		const emailCallback = createOAuthContainmentSignInCallback({
			getCookieStore: createCookieStore,
			findAccountOwner: vi.fn(),
		})
		let oauthBound!: () => void
		let emailFinished!: () => void
		const oauthIsBound = new Promise<void>((resolve) => {
			oauthBound = resolve
		})
		const emailIsFinished = new Promise<void>((resolve) => {
			emailFinished = resolve
		})

		const oauthFlow = runWithOAuthContainmentRequest(
			authCallbackRequest('github'),
			async () => {
				await oauthCallback({ account: oauthHarness.account })
				oauthBound()
				await emailIsFinished
				oauthHarness.setAccountOwner(null)
				return handleLoginOrRegister(
					'',
					oauthHarness.profile,
					oauthHarness.account,
					oauthHarness.options as never,
				)
			},
		)
		const emailFlow = runWithOAuthContainmentRequest(
			authCallbackRequest('postmark'),
			async () => {
				await oauthIsBound
				await emailCallback({ account: emailHarness.account })
				const result = await handleLoginOrRegister(
					'',
					emailHarness.profile,
					emailHarness.account,
					emailHarness.options as never,
				)
				emailFinished()
				return result
			},
		)

		const [oauthResult, emailResult] = await Promise.allSettled([
			oauthFlow,
			emailFlow,
		])
		expect(oauthResult.status).toBe('rejected')
		expect(emailResult).toMatchObject({
			status: 'fulfilled',
			value: { isNewUser: true },
		})
		expect(emailHarness.calls.createUser).toHaveBeenCalledOnce()
		expect(oauthHarness.calls.createUser).not.toHaveBeenCalled()
	})

	it.each<Provider>(['github', 'discord'])(
		'fails closed for an unguarded %s mutation',
		async (provider) => {
			const harness = createLockedAuthHarness({
				provider,
				accountOwner: null,
			})

			await expect(
				harness.adapter.linkAccount?.({
					...harness.account,
					userId: 'attacker',
				}),
			).rejects.toThrow('OAuth containment')
			await expect(
				runWithOAuthContainmentRequest(
					authCallbackRequest(provider),
					() => harness.adapter.createUser?.(harness.profile as never),
				),
			).rejects.toThrow('OAuth containment')
			expect(harness.calls.linkAccount).not.toHaveBeenCalled()
			expect(harness.calls.createUser).not.toHaveBeenCalled()
		},
	)

	it.each(['email', 'google'])(
		'bypasses OAuth callback containment for %s',
		async (provider) => {
			const cookieStore = createCookieStore()
			const findAccountOwner = vi.fn()
			const callback = createOAuthContainmentSignInCallback({
				getCookieStore: () => cookieStore,
				findAccountOwner,
			})

			await expect(
				callback({ account: { provider, providerAccountId: 'account' } }),
			).resolves.toBe(true)
			expect(cookieStore.delete).not.toHaveBeenCalled()
			expect(findAccountOwner).not.toHaveBeenCalled()
		},
	)

	it('rejects a callback whose provider conflicts with its request', async () => {
		const callback = createOAuthContainmentSignInCallback({
			getCookieStore: createCookieStore,
			findAccountOwner: vi.fn(async () => ({ id: 'owner' })),
		})

		await expect(
			runWithOAuthContainmentRequest(
				authCallbackRequest('github'),
				() =>
					callback({
						account: {
							provider: 'discord',
							providerAccountId: 'discord-account',
						},
					}),
			),
		).resolves.toBe(false)
	})

	it('clears both legacy cookies through the callback before lookup', async () => {
		const cookieStore = createCookieStore()
		const findAccountOwner = vi.fn(async () => null)
		const callback = createOAuthContainmentSignInCallback({
			getCookieStore: () => cookieStore,
			findAccountOwner,
		})

		await runWithOAuthContainmentRequest(
			authCallbackRequest('discord'),
			() =>
				callback({
					account: {
						provider: 'discord',
						providerAccountId: 'discord-account',
					},
				}),
		)

		expect(cookieStore.delete.mock.calls).toEqual(
			legacyOAuthLinkCookieNames.map((name) => [name]),
		)
		expect(cookieStore.delete.mock.invocationCallOrder.at(-1)).toBeLessThan(
			findAccountOwner.mock.invocationCallOrder[0] ?? 0,
		)
	})

	it('expires both legacy raw-user cookies without reading values', () => {
		const deleteCookie = vi.fn()

		clearLegacyOAuthLinkCookies({ delete: deleteCookie })

		expect(legacyOAuthLinkCookieNames).toEqual([
			'__oauth-link-uid-discord',
			'__oauth-link-uid-github',
		])
		expect(deleteCookie.mock.calls).toEqual(
			legacyOAuthLinkCookieNames.map((name) => [name]),
		)
	})

	it('asserts that linkAccount events are unreachable', () => {
		expect(() =>
			assertOAuthLinkAccountEventUnreachableDuringContainment({
				account: { provider: 'discord' },
			}),
		).toThrow('linkAccount event reached during OAuth containment')
	})
})

describe('post-sign-in invitation wiring', () => {
	it('uses the final user and treats an empty second result as a no-op', async () => {
		const acceptInvitations = vi
			.fn()
			.mockResolvedValueOnce({ acceptedOrganizationIds: ['org-a'] })
			.mockResolvedValueOnce({ acceptedOrganizationIds: [] })
		const logAccepted = vi.fn()
		const handler = createPostSignInInvitationHandler({
			acceptInvitations,
			logAccepted,
			logFailed: vi.fn(),
		})
		const finalUser = { id: 'final-user', email: 'final@example.com' }

		await handler({ user: finalUser })
		await handler({ user: finalUser })

		expect(acceptInvitations).toHaveBeenNthCalledWith(1, {
			userId: 'final-user',
			email: 'final@example.com',
		})
		expect(acceptInvitations).toHaveBeenNthCalledWith(2, {
			userId: 'final-user',
			email: 'final@example.com',
		})
		expect(logAccepted).toHaveBeenCalledOnce()
		expect(logAccepted).toHaveBeenCalledWith({
			userId: 'final-user',
			organizationCount: 1,
		})
	})
})

describe('Auth.js containment wiring guards', () => {
	it('wires request scope, guarded adapter, and callbacks into Auth.js', () => {
		expect(authSource).toContain('adapter: oauthContainmentAdapter')
		expect(authSource).toContain('runWithOAuthContainmentRequest(request')
		expect(authSource).toContain('signIn: oauthContainmentSignInCallback')
		expect(authSource).toContain(
			'linkAccount: assertOAuthLinkAccountEventUnreachableDuringContainment',
		)
		expect(authSource).toContain('signIn: postSignInInvitationHandler')
	})

	it('omits dangerous email linking from provider builders', () => {
		const github = getGithubProviderConfig({
			clientId: 'github-client',
			clientSecret: 'github-secret',
		})
		const discord = getDiscordProviderConfig({
			clientId: 'discord-client',
			clientSecret: 'discord-secret',
		})

		expect(github).not.toHaveProperty('allowDangerousEmailAccountLinking')
		expect(discord).not.toHaveProperty('allowDangerousEmailAccountLinking')
	})

	it('keeps known-dangerous symbols and Twitter absent', () => {
		for (const symbol of [
			'allowDangerousEmailAccountLinking',
			'courseBuilderAdapter.linkAccount',
			'courseBuilderAdapter.unlinkAccount',
			'TwitterProvider',
			'@auth/core/providers/twitter',
		]) {
			expect(authSource).not.toContain(symbol)
		}
	})
})
