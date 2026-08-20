import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

import { getGithubProviderConfig } from './oauth-provider-config'

const require = createRequire(import.meta.url)
const requireFromAuthCore = createRequire(require.resolve('@auth/core'))
const oauth4webapiPath = requireFromAuthCore.resolve('oauth4webapi')
const { expectNoState, validateAuthResponse } = await import(
	/* @vite-ignore */ oauth4webapiPath
)

const githubIssuer = 'https://github.com/login/oauth'

function githubConfig() {
	return getGithubProviderConfig({
		clientId: 'github-client',
		clientSecret: 'github-secret',
	})
}

describe('GitHub OAuth provider config', () => {
	it('sets GitHub’s RFC 9207 issuer without changing email account linking', () => {
		expect(githubConfig()).toMatchObject({
			issuer: githubIssuer,
			allowDangerousEmailAccountLinking: true,
		})
	})

	it('accepts GitHub’s matching callback issuer in oauth4webapi', () => {
		const config = githubConfig()
		const callback = new URLSearchParams({
			code: 'github-code',
			iss: githubIssuer,
		})

		const validated = validateAuthResponse(
			{ issuer: config.issuer },
			{ client_id: config.clientId },
			callback,
			expectNoState,
		)

		expect([...validated]).toEqual([...callback])
	})

	it('rejects a mismatched callback issuer in oauth4webapi', () => {
		const config = githubConfig()
		const callback = new URLSearchParams({
			code: 'github-code',
			iss: 'https://attacker.example/oauth',
		})

		expect(() =>
			validateAuthResponse(
				{ issuer: config.issuer },
				{ client_id: config.clientId },
				callback,
				expectNoState,
			),
		).toThrowError(
			expect.objectContaining({
				code: 'OAUTH_INVALID_RESPONSE',
			}),
		)
	})
})
