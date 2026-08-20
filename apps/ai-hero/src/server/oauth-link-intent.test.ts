import { createActor } from 'xstate'
import { describe, expect, it, vi } from 'vitest'

import {
	createOAuthLinkIntentService,
	hashOAuthLinkSession,
	oauthLinkIntentMachine,
	type OAuthLinkAccount,
	type OAuthLinkIntentRepository,
	type StoredOAuthLinkIntent,
} from './oauth-link-intent'

const now = new Date('2026-08-09T12:00:00.000Z')

function createMemoryRepository() {
	const intents = new Map<string, StoredOAuthLinkIntent>()
	const accounts = new Map<string, string>()
	const accountWrites = vi.fn()

	const repository: OAuthLinkIntentRepository = {
		async insert(intent) {
			intents.set(intent.tokenDigest, intent)
		},
		async findByTokenDigest(tokenDigest) {
			return intents.get(tokenDigest) ?? null
		},
		async consumeAndLink({ intent, tokenDigest, account, now: consumedAt }) {
			const current = intents.get(tokenDigest)
			if (!current || current.identifier !== intent.identifier) {
				return {
					status: 'denied' as const,
					reasonClass: 'claim-lost' as const,
				}
			}
			if (current.expiresAt <= consumedAt) {
				return { status: 'expired' as const }
			}

			const accountKey = `${account.provider}:${account.providerAccountId}`
			const ownerId = accounts.get(accountKey) ?? null
			if (ownerId && ownerId !== intent.targetUserId) {
				return {
					status: 'denied' as const,
					reasonClass: 'cross-user-owned' as const,
					ownershipReadback: {
						beforeOwnerId: ownerId,
						afterOwnerId: accounts.get(accountKey) ?? null,
					},
				}
			}

			// This delete is the one-use compare-and-swap. It happens before any
			// asynchronous account work, so only one concurrent callback can win.
			if (!intents.delete(tokenDigest)) {
				return {
					status: 'denied' as const,
					reasonClass: 'claim-lost' as const,
				}
			}

			accountWrites({ ...account, userId: intent.targetUserId })
			accounts.set(accountKey, intent.targetUserId)
			return {
				status: 'linked' as const,
				linkKind: ownerId === intent.targetUserId ? ('renewed' as const) : ('created' as const),
				consumedIntent: true as const,
				ownershipReadback: {
					beforeOwnerId: ownerId,
					afterOwnerId: intent.targetUserId,
				},
			}
		},
	}

	return {
		repository,
		accountWrites,
		accounts,
		intents,
	}
}

function createHarness() {
	const memory = createMemoryRepository()
	const observe = vi.fn()
	let tokenCounter = 0
	const service = createOAuthLinkIntentService({
		repository: memory.repository,
		now: () => now,
		newToken: () => `opaque-token-${++tokenCounter}`,
		newNonce: () => `nonce-${tokenCounter}`,
		observe,
	})
	return { ...memory, observe, service }
}

const aliceBinding = hashOAuthLinkSession('alice-session-secret')
const bobBinding = hashOAuthLinkSession('bob-session-secret')

async function issueDiscordIntent(service: ReturnType<typeof createOAuthLinkIntentService>) {
	return service.issue({
		targetUserId: 'alice',
		provider: 'discord',
		sessionBinding: aliceBinding,
	})
}

const discordAccount: OAuthLinkAccount = {
	type: 'oauth',
	provider: 'discord',
	providerAccountId: 'discord-123',
	access_token: 'provider-access-token',
}

describe('OAuth link intent lifecycle machine', () => {
	it('models the successful issued -> consuming -> consumed path', () => {
		const actor = createActor(oauthLinkIntentMachine, {
			input: { expiresAt: now.getTime() + 60_000 },
		}).start()

		expect(actor.getSnapshot().value).toBe('issued')
		actor.send({ type: 'CONSUME', now: now.getTime() })
		expect(actor.getSnapshot().value).toBe('consuming')
		actor.send({ type: 'COMMIT' })
		expect(actor.getSnapshot().value).toBe('consumed')
	})

	it('moves an expired intent directly to expired', () => {
		const actor = createActor(oauthLinkIntentMachine, {
			input: { expiresAt: now.getTime() - 1 },
		}).start()

		actor.send({ type: 'CONSUME', now: now.getTime() })

		expect(actor.getSnapshot().value).toBe('expired')
	})
})

describe('OAuth link intent security contract', () => {
	it('links an unowned Discord account to the session-bound target once', async () => {
		const { service, accountWrites } = createHarness()
		const issued = await issueDiscordIntent(service)

		await expect(
			service.consume({
				rawToken: issued.rawToken,
				provider: 'discord',
				authenticatedUserId: 'alice',
				sessionBinding: aliceBinding,
				account: discordAccount,
			}),
		).resolves.toMatchObject({
			status: 'linked',
			targetUserId: 'alice',
			linkKind: 'created',
			flowId: expect.stringMatching(/^olf_/),
		})
		expect(accountWrites).toHaveBeenCalledOnce()
		expect(accountWrites).toHaveBeenCalledWith(
			expect.objectContaining({ userId: 'alice', provider: 'discord' }),
		)
	})

	it('rejects a tampered opaque token without an account write', async () => {
		const { service, accountWrites } = createHarness()
		await issueDiscordIntent(service)

		await expect(
			service.consume({
				rawToken: 'tampered-token',
				provider: 'discord',
				authenticatedUserId: 'alice',
				sessionBinding: aliceBinding,
				account: discordAccount,
			}),
		).resolves.toEqual({ status: 'denied' })
		expect(accountWrites).not.toHaveBeenCalled()
	})

	it('rejects expiry without an account write', async () => {
		const memory = createMemoryRepository()
		const service = createOAuthLinkIntentService({
			repository: memory.repository,
			now: () => new Date(now.getTime() + 11 * 60_000),
			newToken: () => 'expired-token',
			newNonce: () => 'expired-nonce',
		})
		const issuer = createOAuthLinkIntentService({
			repository: memory.repository,
			now: () => now,
			newToken: () => 'expired-token',
			newNonce: () => 'expired-nonce',
		})
		const issued = await issueDiscordIntent(issuer)

		await expect(
			service.consume({
				rawToken: issued.rawToken,
				provider: 'discord',
				authenticatedUserId: 'alice',
				sessionBinding: aliceBinding,
				account: discordAccount,
			}),
		).resolves.toEqual({ status: 'expired' })
		expect(memory.accountWrites).not.toHaveBeenCalled()
	})

	it('rejects replay after the first successful consume', async () => {
		const { service, accountWrites } = createHarness()
		const issued = await issueDiscordIntent(service)
		const input = {
			rawToken: issued.rawToken,
			provider: 'discord' as const,
			authenticatedUserId: 'alice',
			sessionBinding: aliceBinding,
			account: discordAccount,
		}

		await expect(service.consume(input)).resolves.toMatchObject({
			status: 'linked',
		})
		await expect(service.consume(input)).resolves.toEqual({ status: 'denied' })
		expect(accountWrites).toHaveBeenCalledOnce()
	})

	it('rejects a provider swap without consuming or linking', async () => {
		const { service, accountWrites, intents } = createHarness()
		const issued = await issueDiscordIntent(service)

		await expect(
			service.consume({
				rawToken: issued.rawToken,
				provider: 'github',
				authenticatedUserId: 'alice',
				sessionBinding: aliceBinding,
				account: {
					type: 'oauth',
					provider: 'github',
					providerAccountId: 'github-123',
				},
			}),
		).resolves.toEqual({ status: 'denied' })
		expect(accountWrites).not.toHaveBeenCalled()
		expect(intents.size).toBe(1)
	})

	it('rejects a different authenticated session without consuming', async () => {
		const { service, accountWrites, intents } = createHarness()
		const issued = await issueDiscordIntent(service)

		await expect(
			service.consume({
				rawToken: issued.rawToken,
				provider: 'discord',
				authenticatedUserId: 'alice',
				sessionBinding: bobBinding,
				account: discordAccount,
			}),
		).resolves.toEqual({ status: 'denied' })
		expect(accountWrites).not.toHaveBeenCalled()
		expect(intents.size).toBe(1)
	})

	it('allows only one of two concurrent callbacks to write', async () => {
		const { service, accountWrites } = createHarness()
		const issued = await issueDiscordIntent(service)
		const input = {
			rawToken: issued.rawToken,
			provider: 'discord' as const,
			authenticatedUserId: 'alice',
			sessionBinding: aliceBinding,
			account: discordAccount,
		}

		const results = await Promise.all([service.consume(input), service.consume(input)])

		expect(results.filter((result) => result.status === 'linked')).toHaveLength(1)
		expect(results.filter((result) => result.status === 'denied')).toHaveLength(1)
		expect(accountWrites).toHaveBeenCalledOnce()
	})

	it('allows only one of two different-user intents for the same account', async () => {
		const { service, accountWrites, accounts, observe } = createHarness()
		const aliceIntent = await service.issue({
			targetUserId: 'alice',
			provider: 'discord',
			sessionBinding: aliceBinding,
		})
		const bobIntent = await service.issue({
			targetUserId: 'bob',
			provider: 'discord',
			sessionBinding: bobBinding,
		})

		const results = await Promise.all([
			service.consume({
				rawToken: aliceIntent.rawToken,
				provider: 'discord',
				authenticatedUserId: 'alice',
				sessionBinding: aliceBinding,
				account: discordAccount,
			}),
			service.consume({
				rawToken: bobIntent.rawToken,
				provider: 'discord',
				authenticatedUserId: 'bob',
				sessionBinding: bobBinding,
				account: discordAccount,
			}),
		])

		expect(results.filter((result) => result.status === 'linked')).toHaveLength(1)
		expect(results.filter((result) => result.status === 'denied')).toHaveLength(1)
		expect(accountWrites).toHaveBeenCalledOnce()
		expect(['alice', 'bob']).toContain(accounts.get('discord:discord-123'))
		expect(
			observe.mock.calls.some(
				([event]) => event.action === 'ownership_after' && event.ownerUnchanged === true,
			),
		).toBe(true)
	})

	it('renews tokens for the same owner without changing ownership', async () => {
		const { service, accountWrites, accounts } = createHarness()
		accounts.set('discord:discord-123', 'alice')
		const issued = await issueDiscordIntent(service)

		await expect(
			service.consume({
				rawToken: issued.rawToken,
				provider: 'discord',
				authenticatedUserId: 'alice',
				sessionBinding: aliceBinding,
				account: { ...discordAccount, access_token: 'renewed-token' },
			}),
		).resolves.toMatchObject({
			status: 'linked',
			targetUserId: 'alice',
			linkKind: 'renewed',
			flowId: expect.stringMatching(/^olf_/),
		})
		expect(accountWrites).toHaveBeenCalledOnce()
		expect(accounts.get('discord:discord-123')).toBe('alice')
	})

	it('rejects an OAuth account owned by another user without a write', async () => {
		const { service, accountWrites, accounts, observe } = createHarness()
		accounts.set('discord:discord-123', 'bob')
		const issued = await issueDiscordIntent(service)

		await expect(
			service.consume({
				rawToken: issued.rawToken,
				provider: 'discord',
				authenticatedUserId: 'alice',
				sessionBinding: aliceBinding,
				account: discordAccount,
			}),
		).resolves.toEqual({
			status: 'denied',
			reasonClass: 'cross-user-owned',
		})
		expect(accountWrites).not.toHaveBeenCalled()
		expect(accounts.get('discord:discord-123')).toBe('bob')

		const events = observe.mock.calls.map(([event]) => event)
		const denied = events.find((event) => event.action === 'validation_denied')
		const ownershipAfter = events.find((event) => event.action === 'ownership_after')
		expect(denied).toMatchObject({ reasonClass: 'cross-user-owned' })
		expect(ownershipAfter).toMatchObject({ ownerUnchanged: true })
		expect(new Set(events.map((event) => event.flowId)).size).toBe(1)
		const receipt = JSON.stringify(events)
		expect(receipt).not.toContain('alice')
		expect(receipt).not.toContain('bob')
		expect(receipt).not.toContain('discord-123')
		expect(receipt).not.toContain(issued.rawToken)
	})

	it('emits redacted issued, consumed, and account-linked canary events', async () => {
		const { service, observe } = createHarness()
		const issued = await issueDiscordIntent(service)
		await service.consume({
			rawToken: issued.rawToken,
			provider: 'discord',
			authenticatedUserId: 'alice',
			sessionBinding: aliceBinding,
			account: discordAccount,
		})

		const events = observe.mock.calls.map(([event]) => event)
		expect(events.map((event) => event.action)).toEqual([
			'intent_issued',
			'validation_allowed',
			'ownership_before',
			'ownership_after',
			'consume_result',
			'link_result',
		])
		expect(new Set(events.map((event) => event.flowId)).size).toBe(1)
		const receipt = JSON.stringify(observe.mock.calls)
		expect(receipt).not.toContain('alice')
		expect(receipt).not.toContain('discord-123')
		expect(receipt).not.toContain(issued.rawToken)
	})
})

const githubAccount: OAuthLinkAccount = {
	type: 'oauth',
	provider: 'github',
	providerAccountId: 'github-123',
	access_token: 'github-provider-token',
}

async function issueGithubIntent(service: ReturnType<typeof createOAuthLinkIntentService>) {
	return service.issue({
		targetUserId: 'alice',
		provider: 'github',
		sessionBinding: aliceBinding,
	})
}

describe('GitHub OAuth link intent security contract', () => {
	it('consumes once and refuses replay', async () => {
		const { service, accountWrites, observe } = createHarness()
		const issued = await issueGithubIntent(service)
		const input = {
			rawToken: issued.rawToken,
			provider: 'github' as const,
			authenticatedUserId: 'alice',
			sessionBinding: aliceBinding,
			account: githubAccount,
		}

		await expect(service.consume(input)).resolves.toMatchObject({
			status: 'linked',
			targetUserId: 'alice',
		})
		await expect(service.consume(input)).resolves.toEqual({ status: 'denied' })
		expect(accountWrites).toHaveBeenCalledOnce()
		expect(observe).toHaveBeenCalledWith(
			expect.objectContaining({
				action: 'intent_issued',
				provider: 'github',
				flowId: expect.stringMatching(/^olf_/),
			}),
		)
		expect(observe).toHaveBeenCalledWith(
			expect.objectContaining({
				action: 'link_result',
				provider: 'github',
				result: 'linked',
			}),
		)
	})

	it('refuses expiry, session swap, and provider swap without consuming', async () => {
		const sessionHarness = createHarness()
		const sessionIntent = await issueGithubIntent(sessionHarness.service)
		await expect(
			sessionHarness.service.consume({
				rawToken: sessionIntent.rawToken,
				provider: 'github',
				authenticatedUserId: 'alice',
				sessionBinding: bobBinding,
				account: githubAccount,
			}),
		).resolves.toEqual({ status: 'denied' })
		expect(sessionHarness.intents.size).toBe(1)

		await expect(
			sessionHarness.service.consume({
				rawToken: sessionIntent.rawToken,
				provider: 'github',
				authenticatedUserId: 'bob',
				sessionBinding: aliceBinding,
				account: githubAccount,
			}),
		).resolves.toEqual({ status: 'denied' })
		expect(sessionHarness.intents.size).toBe(1)

		await expect(
			sessionHarness.service.consume({
				rawToken: sessionIntent.rawToken,
				provider: 'discord',
				authenticatedUserId: 'alice',
				sessionBinding: aliceBinding,
				account: discordAccount,
			}),
		).resolves.toEqual({ status: 'denied' })
		expect(sessionHarness.intents.size).toBe(1)
		expect(sessionHarness.accountWrites).not.toHaveBeenCalled()

		const memory = createMemoryRepository()
		const issuer = createOAuthLinkIntentService({
			repository: memory.repository,
			now: () => now,
			newToken: () => 'github-expired-token',
			newNonce: () => 'github-expired-nonce',
		})
		const expired = createOAuthLinkIntentService({
			repository: memory.repository,
			now: () => new Date(now.getTime() + 11 * 60_000),
		})
		const expiredIntent = await issueGithubIntent(issuer)
		await expect(
			expired.consume({
				rawToken: expiredIntent.rawToken,
				provider: 'github',
				authenticatedUserId: 'alice',
				sessionBinding: aliceBinding,
				account: githubAccount,
			}),
		).resolves.toEqual({ status: 'expired' })
		expect(memory.accountWrites).not.toHaveBeenCalled()
	})

	it('allows only one concurrent GitHub callback to link', async () => {
		const { service, accountWrites } = createHarness()
		const issued = await issueGithubIntent(service)
		const input = {
			rawToken: issued.rawToken,
			provider: 'github' as const,
			authenticatedUserId: 'alice',
			sessionBinding: aliceBinding,
			account: githubAccount,
		}

		const results = await Promise.all([service.consume(input), service.consume(input)])

		expect(results.filter((result) => result.status === 'linked')).toHaveLength(1)
		expect(results.filter((result) => result.status === 'denied')).toHaveLength(1)
		expect(accountWrites).toHaveBeenCalledOnce()
	})

	it('never moves a GitHub account owned by another AI Hero user', async () => {
		const { service, accounts, accountWrites, observe } = createHarness()
		accounts.set('github:github-123', 'bob')
		const issued = await issueGithubIntent(service)

		await expect(
			service.consume({
				rawToken: issued.rawToken,
				provider: 'github',
				authenticatedUserId: 'alice',
				sessionBinding: aliceBinding,
				account: githubAccount,
			}),
		).resolves.toEqual({
			status: 'denied',
			reasonClass: 'cross-user-owned',
		})
		expect(accounts.get('github:github-123')).toBe('bob')
		expect(accountWrites).not.toHaveBeenCalled()
		expect(observe).toHaveBeenCalledWith(
			expect.objectContaining({
				action: 'ownership_after',
				ownerUnchanged: true,
			}),
		)
		const receipt = JSON.stringify(observe.mock.calls)
		expect(receipt).not.toContain('github-123')
		expect(receipt).not.toContain(issued.rawToken)
	})
})
