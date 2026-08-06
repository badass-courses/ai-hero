import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { DiscordAccessAction } from './discord-access-action'
import { getDiscordAccessState } from './discord-access'

describe('/discord containment journey', () => {
	it('shows the redirect action for a canonical linked session', async () => {
		const findDiscordAccount = vi.fn(async () => ({
			provider: 'discord',
			providerAccountId: 'discord-123',
		}))
		const state = await getDiscordAccessState({
			getSession: vi.fn(async () => ({
				session: { user: { id: 'canonical-user' } },
			})),
			findDiscordAccount,
		})
		const markup = renderToStaticMarkup(<DiscordAccessAction state={state} />)

		expect(findDiscordAccount).toHaveBeenCalledWith('canonical-user')
		expect(markup).toContain('href="/discord/redirect"')
		expect(markup).toContain('Continue to Discord')
	})

	it('shows no redirect action for an unlinked session', async () => {
		const state = await getDiscordAccessState({
			getSession: vi.fn(async () => ({
				session: { user: { id: 'unlinked-user' } },
			})),
			findDiscordAccount: vi.fn(async () => null),
		})
		const markup = renderToStaticMarkup(<DiscordAccessAction state={state} />)

		expect(markup).not.toContain('/discord/redirect')
		expect(markup).toContain('linking is temporarily unavailable')
	})

	it('does not query accounts or show a redirect for anonymous users', async () => {
		const findDiscordAccount = vi.fn()
		const state = await getDiscordAccessState({
			getSession: vi.fn(async () => ({ session: null })),
			findDiscordAccount,
		})
		const markup = renderToStaticMarkup(<DiscordAccessAction state={state} />)

		expect(findDiscordAccount).not.toHaveBeenCalled()
		expect(markup).not.toContain('/discord/redirect')
	})
})
