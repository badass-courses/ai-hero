import { afterEach, describe, expect, it, vi } from 'vitest'

const accounts = vi.hoisted(() => ({
	findFirst: vi.fn(async () => ({ providerAccountId: 'discord-fixture' })),
}))
vi.mock('@/db', () => ({ db: { query: { accounts } } }))
vi.mock('@/env.mjs', () => ({
	env: {
		DISCORD_GUILD_ID: 'guild-fixture',
		DISCORD_BOT_TOKEN: 'token-fixture',
	},
}))

import { discordRoleClient, removeDiscordRole } from './discord-utils'

const member = (roles: string[]) =>
	new Response(JSON.stringify({ roles }), { status: 200 })

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('removeDiscordRole reports HTTP failures', () => {
	it('returns error when DELETE fails with 503', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(member(['role-1']))
				.mockResolvedValueOnce(new Response('unavailable', { status: 503 })),
		)
		await expect(removeDiscordRole('user', 'role-1')).resolves.toMatchObject({
			status: 'error',
			reason: 'discord remove role failed: 503',
		})
	})

	it('returns error, not role-already-absent, when the member lookup is rate limited', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ message: 'rate limited' }), {
					status: 429,
				}),
			),
		)
		await expect(removeDiscordRole('user', 'role-1')).resolves.toMatchObject({
			status: 'error',
			reason: 'discord member lookup failed: 429',
		})
	})

	it('still skips a user who left the guild and succeeds on 204', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValueOnce(new Response('', { status: 404 })),
		)
		await expect(removeDiscordRole('user', 'role-1')).resolves.toMatchObject({
			status: 'skipped',
			reason: 'Discord member not found in guild',
		})
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(member(['role-1']))
				.mockResolvedValueOnce(new Response(null, { status: 204 })),
		)
		await expect(removeDiscordRole('user', 'role-1')).resolves.toMatchObject({
			status: 'success',
		})
	})
})

describe('removeDiscordRole keeps its contract for existing callers', () => {
	it('rejects when the account lookup fails, so callers retry', async () => {
		accounts.findFirst.mockRejectedValueOnce(
			new Error('account db unavailable'),
		)
		await expect(removeDiscordRole('user', 'role-1')).rejects.toThrow(
			'account db unavailable',
		)
	})
})

describe('discordRoleClient', () => {
	it('throws on retryable failures and treats a missing role on delete as done', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response('', { status: 500 })),
		)
		await expect(discordRoleClient.lookupMember('user')).rejects.toThrow('500')
		await expect(
			discordRoleClient.addRole('discord-fixture', 'role-1'),
		).rejects.toThrow('discord add role failed: 500')

		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response('', { status: 404 })),
		)
		await expect(
			discordRoleClient.removeRole('discord-fixture', 'role-1'),
		).resolves.toBeUndefined()
		await expect(
			discordRoleClient.addRole('discord-fixture', 'role-1'),
		).rejects.toThrow('404')
	})

	it('rejects a 200 body without roles', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })),
		)
		await expect(discordRoleClient.lookupMember('user')).rejects.toThrow(
			'returned no roles',
		)
	})
})
