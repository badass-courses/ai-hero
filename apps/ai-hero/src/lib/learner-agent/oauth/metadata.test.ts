import { describe, expect, it } from 'vitest'

import { GET as rootAuthorizationServer } from '@/app/.well-known/oauth-authorization-server/route'
import { GET as authorizationServer } from '@/app/.well-known/oauth-authorization-server/oauth/route'
import { GET as rootResource } from '@/app/.well-known/oauth-protected-resource/route'
import { GET as mcpResource } from '@/app/.well-known/oauth-protected-resource/mcp/route'
import { GET as openidConfiguration } from '@/app/oauth/.well-known/openid-configuration/route'

const BASE = 'http://localhost:3000'

describe('OAuth discovery', () => {
	it('serves RFC 9728 metadata for /mcp at both well-known paths', async () => {
		for (const response of [mcpResource(), rootResource()]) {
			expect(response.headers.get('access-control-allow-origin')).toBe('*')
			expect(await response.json()).toMatchObject({
				resource: `${BASE}/mcp`,
				authorization_servers: [`${BASE}/oauth`],
				scopes_supported: ['learner:read'],
				bearer_methods_supported: ['header'],
			})
		}
	})

	it('serves RFC 8414 metadata for issuer /oauth with PKCE S256 and CIMD', async () => {
		for (const response of [authorizationServer(), rootAuthorizationServer()]) {
			expect(await response.json()).toMatchObject({
				issuer: `${BASE}/oauth`,
				authorization_endpoint: `${BASE}/oauth/authorize`,
				token_endpoint: `${BASE}/oauth/token`,
				registration_endpoint: `${BASE}/oauth/register`,
				revocation_endpoint: `${BASE}/oauth/revoke`,
				response_types_supported: ['code'],
				grant_types_supported: [
					'authorization_code',
					'urn:ietf:params:oauth:grant-type:device_code',
				],
				code_challenge_methods_supported: ['S256'],
				token_endpoint_auth_methods_supported: ['none'],
				scopes_supported: ['learner:read'],
				client_id_metadata_document_supported: true,
			})
		}
	})

	it('keeps every existing OIDC field for the CLI and only adds the code flow', async () => {
		const previous = process.env.NEXT_PUBLIC_URL
		process.env.NEXT_PUBLIC_URL = BASE
		try {
			const config = await (await openidConfiguration()).json()
			expect(config).toMatchObject({
				token_endpoint: `${BASE}/oauth/token`,
				token_endpoint_auth_methods_supported: [],
				response_types_supported: ['token'],
				scopes_supported: ['content:read', 'progress'],
				issuer: `${BASE}/oauth`,
				registration_endpoint: `${BASE}/oauth/register`,
				device_authorization_endpoint: `${BASE}/oauth/device/code`,
				claims_supported: ['email'],
				userinfo_endpoint: `${BASE}/oauth/userinfo`,
				authorization_endpoint: `${BASE}/oauth/authorize`,
				revocation_endpoint: `${BASE}/oauth/revoke`,
				code_challenge_methods_supported: ['S256'],
			})
		} finally {
			if (previous === undefined) delete process.env.NEXT_PUBLIC_URL
			else process.env.NEXT_PUBLIC_URL = previous
		}
	})
})
