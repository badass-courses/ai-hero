import { LEARNER_READ_SCOPE } from '../identity'
import { resolveOAuthClient, type ClientResolution } from './client'
import { isS256Challenge, type AuthorizeRequest } from './codes'
import type { LearnerOAuthUrls } from './metadata'
import { matchesRegisteredRedirect } from './redirect-uri'

const MAX_STATE_LENGTH = 1024

/** Whether `value` names the MCP resource, ignoring a trailing slash. */
export function isLearnerResource(value: string, urls: LearnerOAuthUrls) {
	try {
		const asked = new URL(value)
		const ours = new URL(urls.resource)
		return (
			!asked.hash &&
			!asked.search &&
			asked.origin === ours.origin &&
			asked.pathname.replace(/\/+$/, '') === ours.pathname.replace(/\/+$/, '')
		)
	} catch {
		return false
	}
}

/** A missing scope means `learner:read`; nothing wider is ever granted. */
export function isLearnerScope(scope: string | null) {
	if (scope === null) return true
	const scopes = scope.split(/\s+/).filter(Boolean)
	return scopes.every((entry) => entry === LEARNER_READ_SCOPE)
}

export type AuthorizeCheck =
	| { ok: true; request: AuthorizeRequest }
	/** Client or redirect is unknown: show an error, never redirect. */
	| { ok: false; kind: 'show'; reason: string }
	/** The redirect is trusted: send the error back to the client. */
	| {
			ok: false
			kind: 'redirect'
			redirectUri: string
			state: string | null
			error: string
			description: string
	  }

/**
 * Validates `/oauth/authorize` before anything is shown. Client and
 * redirect first: until both check out, errors stay on our page, so the
 * endpoint can never bounce a learner to an unregistered URL.
 */
export async function checkAuthorizeRequest(
	params: URLSearchParams,
	urls: LearnerOAuthUrls,
	resolveClient: (
		clientId: unknown,
	) => Promise<ClientResolution> = resolveOAuthClient,
): Promise<AuthorizeCheck> {
	const resolution = await resolveClient(params.get('client_id'))
	if (!resolution.ok)
		return { ok: false, kind: 'show', reason: 'invalid_client' }
	const { client } = resolution

	const redirectUri = params.get('redirect_uri')
	if (
		!redirectUri ||
		!matchesRegisteredRedirect(client.redirectUris, redirectUri)
	)
		return { ok: false, kind: 'show', reason: 'invalid_redirect_uri' }

	const rawState = params.get('state')
	const state =
		rawState && rawState.length <= MAX_STATE_LENGTH ? rawState : null
	const back = (error: string, description: string): AuthorizeCheck => ({
		ok: false,
		kind: 'redirect',
		redirectUri,
		state,
		error,
		description,
	})

	if (rawState && rawState.length > MAX_STATE_LENGTH)
		return back('invalid_request', 'state is too long.')
	if (params.get('response_type') !== 'code')
		return back('unsupported_response_type', 'Only response_type=code.')
	if (
		params.get('code_challenge_method') !== 'S256' ||
		!isS256Challenge(params.get('code_challenge'))
	)
		return back('invalid_request', 'PKCE with S256 is required.')
	if (!isLearnerScope(params.get('scope')))
		return back('invalid_scope', `The only scope is ${LEARNER_READ_SCOPE}.`)
	const resource = params.get('resource')
	if (resource !== null && !isLearnerResource(resource, urls))
		return back('invalid_target', `The only resource is ${urls.resource}.`)

	return {
		ok: true,
		request: {
			clientId: client.clientId,
			clientName: client.clientName,
			clientHost: client.clientHost,
			redirectUri,
			codeChallenge: params.get('code_challenge') as string,
			state,
			resource,
		},
	}
}

/** The client's redirect with `code` or `error`, `state` and `iss`. */
export function clientRedirect(
	redirectUri: string,
	fields: Record<string, string | null>,
	urls: LearnerOAuthUrls,
) {
	const url = new URL(redirectUri)
	for (const [key, value] of Object.entries(fields))
		if (value !== null) url.searchParams.set(key, value)
	url.searchParams.set('iss', urls.issuer)
	return url.toString()
}
