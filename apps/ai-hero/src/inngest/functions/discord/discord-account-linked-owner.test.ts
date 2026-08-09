import { describe, expect, it } from 'vitest'

import { resolveDiscordRoleSyncCredentials } from './discord-account-linked-owner'

describe('Discord role-sync ownership gate', () => {
	it('uses credentials from the exact database-owned account', () => {
		const eventAccessToken = 'untrusted-event-token'
		const credentials = resolveDiscordRoleSyncCredentials({
			eventUserId: 'alice',
			eventProviderAccountId: 'discord-123',
			currentAccount: {
				userId: 'alice',
				providerAccountId: 'discord-123',
				accessToken: 'verified-database-token',
			},
		})

		expect(credentials).toEqual({ accessToken: 'verified-database-token' })
		expect(credentials?.accessToken).not.toBe(eventAccessToken)
	})

	it.each([
		{
			userId: 'bob',
			providerAccountId: 'discord-123',
			accessToken: 'db-token',
		},
		{
			userId: 'alice',
			providerAccountId: 'discord-999',
			accessToken: 'db-token',
		},
		{
			userId: 'alice',
			providerAccountId: 'discord-123',
			accessToken: null,
		},
		null,
	])('denies moved, missing, or tokenless ownership', (currentAccount) => {
		expect(
			resolveDiscordRoleSyncCredentials({
				eventUserId: 'alice',
				eventProviderAccountId: 'discord-123',
				currentAccount,
			}),
		).toBeNull()
	})
})
