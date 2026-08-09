import { describe, expect, it } from 'vitest'

import {
	isOAuthLinkEnabledForUser,
	parseOAuthLinkUserAllowlist,
} from './oauth-link-rollout'

describe('Discord relink rollout gate', () => {
	it('fails closed with no allowlist and no global gate', () => {
		expect(
			isOAuthLinkEnabledForUser('alice', {
				allowedUserIds: new Set(),
				globalEnabled: false,
			}),
		).toBe(false)
	})

	it('allows only explicit server-side user ids during canary rollout', () => {
		const config = {
			allowedUserIds: parseOAuthLinkUserAllowlist(' alice, bob ,, '),
			globalEnabled: false,
		}

		expect(isOAuthLinkEnabledForUser('alice', config)).toBe(true)
		expect(isOAuthLinkEnabledForUser('bob', config)).toBe(true)
		expect(isOAuthLinkEnabledForUser('mallory', config)).toBe(false)
	})

	it('keeps global enable as a separate later gate', () => {
		expect(
			isOAuthLinkEnabledForUser('any-user', {
				allowedUserIds: new Set(),
				globalEnabled: true,
			}),
		).toBe(true)
	})
})
