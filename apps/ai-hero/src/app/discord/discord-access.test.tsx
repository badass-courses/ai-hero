import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { DiscordAccessAction } from './discord-access-action'
import { getDiscordAccessState } from './discord-access'

const recoveryActions = {
	switchLogin: async () => {},
	supportEmail: 'support@example.com',
}

describe('/discord containment journey', () => {
	it('shows the redirect action for a canonical linked session', async () => {
		const findDiscordAccount = vi.fn(async () => ({
			provider: 'discord',
			providerAccountId: 'discord-123',
			access_token: 'active-token',
		}))
		const state = await getDiscordAccessState({
			getSession: vi.fn(async () => ({
				session: { user: { id: 'canonical-user' } },
			})),
			findDiscordAccount,
		})
		const markup = renderToStaticMarkup(
			<DiscordAccessAction state={state} {...recoveryActions} />,
		)

		expect(findDiscordAccount).toHaveBeenCalledWith('canonical-user')
		expect(markup).toContain('href="/discord/redirect"')
		expect(markup).toContain('Continue to Discord')
	})

	it('offers secure renewal when the linked account credentials are stale', async () => {
		const state = await getDiscordAccessState({
			getSession: vi.fn(async () => ({
				session: { user: { id: 'relink-user' } },
			})),
			findDiscordAccount: vi.fn(async () => ({
				provider: 'discord',
				access_token: null,
			})),
		})
		const markup = renderToStaticMarkup(
			<DiscordAccessAction
				state={state}
				requestLink={async () => {}}
				{...recoveryActions}
			/>,
		)

		expect(state).toBe('reconnect-required')
		expect(markup).toContain('Discord needs to be reconnected')
		expect(markup).toContain('Reconnect Discord')
		expect(markup).not.toContain('token')
		expect(markup).not.toContain('relink-user')
	})

	it('shows the secure link action for an authenticated unlinked session', async () => {
		const state = await getDiscordAccessState({
			getSession: vi.fn(async () => ({
				session: { user: { id: 'unlinked-user' } },
			})),
			findDiscordAccount: vi.fn(async () => null),
		})
		const markup = renderToStaticMarkup(
			<DiscordAccessAction
				state={state}
				requestLink={async () => {}}
				{...recoveryActions}
			/>,
		)

		expect(markup).toContain('Link Discord account')
		expect(markup).toContain('type="submit"')
		expect(markup).not.toContain('name="userId"')
		expect(markup).not.toContain('name="provider"')
	})

	it('maps the account conflict result to an explicit state', async () => {
		const state = await getDiscordAccessState({
			getSession: vi.fn(async () => ({
				session: { user: { id: 'unlinked-user' } },
			})),
			findDiscordAccount: vi.fn(async () => null),
			linkResult: 'account-conflict',
		})

		expect(state).toBe('account-conflict')
	})

	it('shows safe recovery actions for an account conflict', async () => {
		const state = await getDiscordAccessState({
			getSession: vi.fn(async () => ({
				session: { user: { id: 'current-user-private-id' } },
			})),
			findDiscordAccount: vi.fn(async () => ({
				access_token: null,
				providerAccountId: 'discord-private-id',
				userId: 'owner-ref-private-id',
			})),
			linkResult: 'account-conflict',
		})
		const markup = renderToStaticMarkup(
			<DiscordAccessAction state={state} {...recoveryActions} />,
		)

		expect(markup).toContain(
			'This Discord account is already connected to another AI Hero login.',
		)
		expect(markup).toContain(
			'Sign out, then sign in to AI Hero with the email you used when you first connected Discord.',
		)
		expect(markup).toContain('Switch AI Hero login')
		expect(markup).toContain('href="mailto:support@example.com"')
		expect(markup).toContain('Contact support')
		expect(markup).not.toContain('Try again')
		expect(markup).not.toContain('current-user-private-id')
		expect(markup).not.toContain('discord-private-id')
		expect(markup).not.toContain('owner-ref-private-id')
	})

	it.each([
		['expired', 'This link expired'],
		['denied', 'We couldn'],
	] as const)('shows the safe %s retry state', async (linkResult, message) => {
		const state = await getDiscordAccessState({
			getSession: vi.fn(async () => ({
				session: { user: { id: 'unlinked-user' } },
			})),
			findDiscordAccount: vi.fn(async () => null),
			linkResult,
		})
		const markup = renderToStaticMarkup(
			<DiscordAccessAction
				state={state}
				requestLink={async () => {}}
				{...recoveryActions}
			/>,
		)

		expect(markup).toContain(message)
		expect(markup).toContain('Try again')
		expect(markup).not.toContain('session')
		expect(markup).not.toContain('token')
	})

	it('does not query accounts and offers email sign-in to anonymous users', async () => {
		const findDiscordAccount = vi.fn()
		const state = await getDiscordAccessState({
			getSession: vi.fn(async () => ({ session: null })),
			findDiscordAccount,
		})
		const markup = renderToStaticMarkup(
			<DiscordAccessAction state={state} {...recoveryActions} />,
		)

		expect(findDiscordAccount).not.toHaveBeenCalled()
		expect(markup).toContain('/login?callbackUrl=%2Fdiscord')
		expect(markup).not.toContain('/discord/redirect')
	})
})
