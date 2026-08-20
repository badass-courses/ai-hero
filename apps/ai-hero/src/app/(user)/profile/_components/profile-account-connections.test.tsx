import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/brand/icons', () => ({
	Icon: ({ name }: { name: string }) => <span>{name}</span>,
}))
vi.mock('@/lib/discord-disconnect-action', () => ({
	disconnectDiscord: vi.fn(),
}))
vi.mock('@/lib/github-query', () => ({ disconnectGithub: vi.fn() }))
vi.mock('@/lib/oauth-link-actions', () => ({
	requestGithubOAuthAccountLink: async () => {},
}))

import {
	hasUsableProfileOAuthAccount,
	parseGithubProfileLinkStatus,
} from '../profile-link-status'
import { ProfileAccountConnections } from './profile-account-connections'

const base = {
	githubAvailable: true,
	githubConnected: false,
	githubLinkingEnabled: false,
	githubLinkStatus: null,
	discordAvailable: true,
	discordConnected: false,
}

describe('Profile account connections', () => {
	it('offers GitHub Connect only when rollout enables the authenticated user', () => {
		const markup = renderToStaticMarkup(
			<ProfileAccountConnections {...base} githubLinkingEnabled />,
		)

		expect(markup).toContain('GitHub')
		expect(markup).toContain('type="button"')
		expect(markup).toContain('Connect')
		expect(markup).not.toContain('<form')
		expect(markup).not.toContain('Not enabled')
		for (const privateValue of [
			'userId',
			'providerAccountId',
			'access_token',
			'oauth-link-intent',
		]) {
			expect(markup).not.toContain(privateValue)
		}
	})

	it('gives blocked GitHub users honest rollout copy', () => {
		const markup = renderToStaticMarkup(
			<ProfileAccountConnections {...base} discordAvailable={false} />,
		)

		expect(markup).toContain('Not enabled')
		expect(markup).toContain(
			'GitHub linking is not enabled for this account yet',
		)
		expect(markup).not.toContain('Unavailable')
		expect(markup).not.toContain('outage')
	})

	it('routes an unlinked Discord user to the existing secure /discord flow', () => {
		const markup = renderToStaticMarkup(
			<ProfileAccountConnections {...base} githubAvailable={false} />,
		)

		expect(markup).toContain('Discord')
		expect(markup).toContain('href="/discord"')
		expect(markup).toContain('Connect')
		expect(markup).not.toContain('Unavailable')
	})

	it('treats only provider rows with usable credentials as connected', () => {
		const accounts = [
			{ provider: 'github', access_token: null },
			{ provider: 'discord', access_token: 'discord-token' },
		]

		expect(hasUsableProfileOAuthAccount(accounts, 'github')).toBe(false)
		expect(hasUsableProfileOAuthAccount(accounts, 'discord')).toBe(true)
	})

	it('keeps disconnect actions for already-linked providers', () => {
		const markup = renderToStaticMarkup(
			<ProfileAccountConnections
				{...base}
				githubConnected
				discordConnected
			/>,
		)

		expect(markup.match(/Disconnect/g)).toHaveLength(2)
		expect(markup).not.toContain('href="/discord"')
		expect(markup).not.toContain('Not enabled')
	})

	it('shows only bounded GitHub callback results', () => {
		expect(parseGithubProfileLinkStatus('account-conflict')).toBe(
			'account-conflict',
		)
		expect(parseGithubProfileLinkStatus('linked')).toBe('linked')
		expect(
			parseGithubProfileLinkStatus('linked&token=must-not-render'),
		).toBeNull()
		expect(parseGithubProfileLinkStatus('provider-account-123')).toBeNull()
	})

	it('renders account conflicts without private account data', () => {
		const markup = renderToStaticMarkup(
			<ProfileAccountConnections
				{...base}
				githubLinkingEnabled
				githubLinkStatus="account-conflict"
				discordAvailable={false}
			/>,
		)

		expect(markup).toContain(
			'That GitHub account is already connected to another AI Hero login.',
		)
		expect(markup).not.toContain('provider-account-123')
	})
})
