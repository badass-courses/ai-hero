import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { DiscordAccessAction } from './discord-access-action'
import { getDiscordAccessState } from './discord-access'

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
		const markup = renderToStaticMarkup(<DiscordAccessAction state={state} />)

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

		expect(state).toBe('ready')
	})

	it('keeps the button disabled outside the server-side canary allowlist', async () => {
		const state = await getDiscordAccessState({
			getSession: vi.fn(async () => ({
				session: { user: { id: 'not-allowlisted' } },
			})),
			findDiscordAccount: vi.fn(async () => null),
			canLinkUser: () => false,
		})
		const markup = renderToStaticMarkup(<DiscordAccessAction state={state} />)

		expect(state).toBe('rollout-unavailable')
		expect(markup).toContain('rolling out gradually')
		expect(markup).toContain('disabled')
	})

	it('shows the secure link action for an authenticated unlinked session', async () => {
		const state = await getDiscordAccessState({
			getSession: vi.fn(async () => ({
				session: { user: { id: 'unlinked-user' } },
			})),
			findDiscordAccount: vi.fn(async () => null),
		})
		const markup = renderToStaticMarkup(
			<DiscordAccessAction state={state} requestLink={async () => {}} />,
		)

		expect(markup).toContain('Link Discord account')
		expect(markup).toContain('type="submit"')
		expect(markup).not.toContain('name="userId"')
		expect(markup).not.toContain('name="provider"')
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
			<DiscordAccessAction state={state} requestLink={async () => {}} />,
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
		const markup = renderToStaticMarkup(<DiscordAccessAction state={state} />)

		expect(findDiscordAccount).not.toHaveBeenCalled()
		expect(markup).toContain('/login?callbackUrl=%2Fdiscord')
		expect(markup).not.toContain('/discord/redirect')
	})
})
