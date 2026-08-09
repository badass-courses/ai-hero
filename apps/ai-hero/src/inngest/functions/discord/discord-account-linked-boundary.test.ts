import { describe, expect, it, vi } from 'vitest'

import { runDiscordProviderBoundary } from './discord-account-linked-boundary'

describe('Discord role-sync provider boundary', () => {
	it('uses the current database token without exposing it as output', async () => {
		const callProvider = vi.fn(async () => ({ id: 'discord-user' }))

		const result = await runDiscordProviderBoundary({
			eventUserId: 'alice',
			eventProviderAccountId: 'discord-123',
			findCurrentAccount: vi.fn(async () => ({
				userId: 'alice',
				providerAccountId: 'discord-123',
				accessToken: 'database-token',
			})),
			callProvider,
			onDenied: vi.fn(),
		})

		expect(callProvider).toHaveBeenCalledWith('database-token')
		expect(result).toEqual({
			status: 'allowed',
			value: { id: 'discord-user' },
		})
		expect(JSON.stringify(result)).not.toContain('database-token')
	})

	it.each([
		{
			userId: 'bob',
			providerAccountId: 'discord-123',
			accessToken: 'other-token',
		},
		{
			userId: 'alice',
			providerAccountId: 'discord-999',
			accessToken: 'other-token',
		},
		{
			userId: 'alice',
			providerAccountId: 'discord-123',
			accessToken: null,
		},
		null,
	])(
		'does not call Discord for moved or missing ownership',
		async (account) => {
			const callProvider = vi.fn()
			const onDenied = vi.fn()

			await expect(
				runDiscordProviderBoundary({
					eventUserId: 'alice',
					eventProviderAccountId: 'discord-123',
					findCurrentAccount: vi.fn(async () => account),
					callProvider,
					onDenied,
				}),
			).resolves.toEqual({ status: 'denied' })
			expect(callProvider).not.toHaveBeenCalled()
			expect(onDenied).toHaveBeenCalledOnce()
		},
	)
})
