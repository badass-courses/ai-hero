import { describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: () => ({}) },
}))
vi.mock('@/lib/discord-utils', () => ({ discordRoleClient: {} }))
vi.mock('@/lib/subscriptions', () => ({ getSubscriptionStatus: vi.fn() }))
vi.mock('@/server/oauth-link-observability', () => ({
	observeOAuthLinkCanary: vi.fn(),
}))

import { missingDiscordRoleIds } from './discord-account-linked'

describe('missingDiscordRoleIds', () => {
	it('returns cohort and workshop roles the member lacks, once each', () => {
		expect(
			missingDiscordRoleIds(
				['everyone', 'cohort-005'],
				[
					{ metadata: { discordRoleId: 'cohort-005' } },
					{ metadata: { discordRoleId: 'crash-course' } },
					{ metadata: { discordRoleId: 'crash-course' } },
				],
			),
		).toEqual(['crash-course'])
	})

	it('ignores entitlements without a role id', () => {
		expect(
			missingDiscordRoleIds(
				[],
				[
					{ metadata: null },
					{ metadata: {} },
					{ metadata: { discordRoleId: '' } },
				],
			),
		).toEqual([])
	})
})
