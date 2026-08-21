import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
	isGithubOAuthLinkEnabled,
	parseGithubOAuthLinkUserAllowlist,
} from './github-oauth-link-rollout'

const envSource = readFileSync(new URL('../env.mjs', import.meta.url), 'utf8')

describe('GitHub OAuth link rollout gate', () => {
	it('fails closed with no allowlist and no global gate', () => {
		expect(
			isGithubOAuthLinkEnabled('alice', {
				allowedUserIds: new Set(),
				globalEnabled: false,
			}),
		).toBe(false)
	})

	it('allows only explicit server-side user ids during canary rollout', () => {
		const config = {
			allowedUserIds: parseGithubOAuthLinkUserAllowlist(' alice, bob ,, '),
			globalEnabled: false,
		}

		expect(isGithubOAuthLinkEnabled('alice', config)).toBe(true)
		expect(isGithubOAuthLinkEnabled('bob', config)).toBe(true)
		expect(isGithubOAuthLinkEnabled('mallory', config)).toBe(false)
	})

	it('keeps global enable as a separate later gate', () => {
		expect(
			isGithubOAuthLinkEnabled('any-user', {
				allowedUserIds: new Set(),
				globalEnabled: true,
			}),
		).toBe(true)
	})

	it('declares both GitHub rollout variables in schema and runtime wiring', () => {
		for (const variable of [
			'AIH_GITHUB_RELINK_USER_ALLOWLIST',
			'AIH_GITHUB_RELINK_GLOBAL_ENABLED',
		]) {
			expect(envSource.split(variable)).toHaveLength(4)
		}
		expect(envSource).toContain(
			"AIH_GITHUB_RELINK_GLOBAL_ENABLED: z.enum(['true', 'false']).optional()",
		)
	})
})
