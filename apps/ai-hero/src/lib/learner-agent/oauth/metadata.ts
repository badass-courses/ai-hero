import type { SiteUrls } from '@ai-hero/learner-agent'

import { LEARNER_READ_SCOPE, LEARNER_TOKEN_TTL_MS } from '../identity'
import { learnerSiteUrls } from '../site'

/**
 * The OAuth 2.1 surface for the learner MCP server. `/mcp` is the protected
 * resource; `/oauth` is its authorization server, the same issuer the device
 * flow already publishes. Every value derives from the site URL.
 */
export function learnerOAuthUrls(site: SiteUrls = learnerSiteUrls()) {
	const base = site.baseUrl
	return {
		baseUrl: base,
		resource: site.mcpUrl,
		resourceMetadata: `${base}/.well-known/oauth-protected-resource/mcp`,
		issuer: `${base}/oauth`,
		authorize: `${base}/oauth/authorize`,
		consent: `${base}/oauth/authorize/consent`,
		decision: `${base}/oauth/authorize/decision`,
		token: `${base}/oauth/token`,
		register: `${base}/oauth/register`,
		revoke: `${base}/oauth/revoke`,
		deviceAuthorization: `${base}/oauth/device/code`,
		guide: site.instructionsUrl,
	}
}

export type LearnerOAuthUrls = ReturnType<typeof learnerOAuthUrls>

/** Seconds an OAuth-issued learner token lives: the same 90 days. */
export const LEARNER_TOKEN_TTL_SECONDS = Math.floor(LEARNER_TOKEN_TTL_MS / 1000)

const GRANT_TYPES = [
	'authorization_code',
	'urn:ietf:params:oauth:grant-type:device_code',
]

/** RFC 9728 protected resource metadata for `/mcp`. */
export function protectedResourceMetadata(urls = learnerOAuthUrls()) {
	return {
		resource: urls.resource,
		authorization_servers: [urls.issuer],
		scopes_supported: [LEARNER_READ_SCOPE],
		bearer_methods_supported: ['header'],
		resource_name: 'AI Hero',
		resource_documentation: urls.guide,
	}
}

/** RFC 8414 authorization server metadata for issuer `/oauth`. */
export function authorizationServerMetadata(urls = learnerOAuthUrls()) {
	return {
		issuer: urls.issuer,
		authorization_endpoint: urls.authorize,
		token_endpoint: urls.token,
		registration_endpoint: urls.register,
		revocation_endpoint: urls.revoke,
		device_authorization_endpoint: urls.deviceAuthorization,
		response_types_supported: ['code'],
		response_modes_supported: ['query'],
		grant_types_supported: GRANT_TYPES,
		code_challenge_methods_supported: ['S256'],
		token_endpoint_auth_methods_supported: ['none'],
		revocation_endpoint_auth_methods_supported: ['none'],
		scopes_supported: [LEARNER_READ_SCOPE],
		client_id_metadata_document_supported: true,
		authorization_response_iss_parameter_supported: true,
	}
}

/**
 * Fields the authorization code flow adds to the existing OIDC document.
 * Additive only: the device flow's fields stay as they are for the CLI.
 */
export function oidcAuthorizationCodeFields(urls = learnerOAuthUrls()) {
	return {
		authorization_endpoint: urls.authorize,
		revocation_endpoint: urls.revoke,
		grant_types_supported: GRANT_TYPES,
		code_challenge_methods_supported: ['S256'],
		client_id_metadata_document_supported: true,
	}
}

const quoted = (value: string) => `"${value.replace(/["\\]/g, '')}"`

/**
 * The `WWW-Authenticate` challenge `/mcp` sends. With no token it names
 * only the metadata and scope (RFC 6750 §3: no error code when no
 * credentials were sent); with a bad token it adds `invalid_token`.
 */
export function learnerSignInChallenge(
	options: { error?: 'invalid_token'; description?: string } = {},
	urls = learnerOAuthUrls(),
) {
	const parts = [
		`resource_metadata=${quoted(urls.resourceMetadata)}`,
		`scope=${quoted(LEARNER_READ_SCOPE)}`,
	]
	if (options.error) parts.push(`error=${quoted(options.error)}`)
	if (options.description)
		parts.push(`error_description=${quoted(options.description)}`)
	return `Bearer ${parts.join(', ')}`
}

/** Browser clients (the MCP inspector) read metadata and tokens cross-origin. */
export const OAUTH_CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers':
		'Authorization, Content-Type, MCP-Protocol-Version',
	'Access-Control-Max-Age': '86400',
} as const

export const METADATA_HEADERS = {
	...OAUTH_CORS_HEADERS,
	'Cache-Control': 'public, max-age=300, s-maxage=3600',
	'Content-Type': 'application/json',
} as const

/** Token, register and revoke answers are credentials or about them. */
export const OAUTH_NO_STORE_HEADERS = {
	...OAUTH_CORS_HEADERS,
	'Cache-Control': 'no-store',
	Pragma: 'no-cache',
} as const

export const corsPreflight = () =>
	new Response(null, { status: 204, headers: OAUTH_CORS_HEADERS })

export const oauthJson = (body: unknown, status = 200) =>
	Response.json(body, { status, headers: OAUTH_NO_STORE_HEADERS })

export const oauthError = (error: string, description: string, status = 400) =>
	oauthJson({ error, error_description: description }, status)
