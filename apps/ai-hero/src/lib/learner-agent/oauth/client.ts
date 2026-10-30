import { log } from '@/server/logger'

import { fetchClientMetadataDocument, type CimdFetchResult } from './cimd-fetch'
import { oauthRateLimit } from './rate-limit'
import { isAllowedRedirectUri } from './redirect-uri'
import { nowSeconds, seal, unseal } from './sealed'

/**
 * Who is asking to sign a learner in. Two kinds, neither stored:
 *
 * - CIMD: the `client_id` is an HTTPS URL to the client's own metadata
 *   document, fetched (guarded) and cached by its Cache-Control.
 * - Stateless DCR: `/oauth/register` seals the client's name and redirect
 *   URIs into the `client_id` itself.
 *
 * Every client is public: PKCE carries the proof, there is no secret.
 */
export type OAuthClient = {
	clientId: string
	clientName: string
	redirectUris: string[]
	kind: 'cimd' | 'dcr'
	/** For logs: the metadata host for CIMD, the first redirect host for DCR. */
	clientHost: string
}

export const DCR_CLIENT_PREFIX = 'aih_dcr_'
const MAX_REDIRECT_URIS = 5
const MAX_CLIENT_NAME = 80

/** Printable, single-line, bounded: the name is shown on the consent page. */
export function cleanClientName(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const name = value
		.replace(
			/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,
			'',
		)
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_CLIENT_NAME)
	return name || null
}

const hostOf = (uri: string) => {
	try {
		return new URL(uri).host
	} catch {
		return 'unknown'
	}
}

export type RegistrationResult =
	| { ok: true; clientName: string; redirectUris: string[] }
	| {
			ok: false
			error: 'invalid_redirect_uri' | 'invalid_client_metadata'
			description: string
	  }

/** RFC 7591 metadata, narrowed to what a public PKCE client may ask for. */
export function parseRegistration(
	body: Record<string, unknown>,
): RegistrationResult {
	const uris = body.redirect_uris
	if (
		!Array.isArray(uris) ||
		uris.length === 0 ||
		uris.length > MAX_REDIRECT_URIS ||
		!uris.every(isAllowedRedirectUri)
	) {
		return {
			ok: false,
			error: 'invalid_redirect_uri',
			description: `Send 1 to ${MAX_REDIRECT_URIS} redirect_uris, each https:// or http://localhost, without a fragment.`,
		}
	}
	const grantTypes = body.grant_types
	if (
		grantTypes !== undefined &&
		(!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code'))
	) {
		return {
			ok: false,
			error: 'invalid_client_metadata',
			description: 'Only the authorization_code grant is supported.',
		}
	}
	const responseTypes = body.response_types
	if (
		responseTypes !== undefined &&
		(!Array.isArray(responseTypes) || !responseTypes.includes('code'))
	) {
		return {
			ok: false,
			error: 'invalid_client_metadata',
			description: 'Only the code response type is supported.',
		}
	}
	const redirectUris = [...new Set(uris as string[])]
	return {
		ok: true,
		redirectUris,
		clientName:
			cleanClientName(body.client_name) ?? hostOf(redirectUris[0] ?? ''),
	}
}

type SealedClient = { v: 1; n: string; r: string[]; iat: number }

/** A stateless DCR client id, or null when the auth secret is missing. */
export function mintDcrClientId(clientName: string, redirectUris: string[]) {
	const sealed = seal('client', {
		v: 1,
		n: clientName,
		r: redirectUris,
		iat: nowSeconds(),
	} satisfies SealedClient)
	return sealed ? `${DCR_CLIENT_PREFIX}${sealed}` : null
}

export function openDcrClientId(clientId: string): OAuthClient | null {
	if (!clientId.startsWith(DCR_CLIENT_PREFIX)) return null
	const value = unseal(
		'client',
		clientId.slice(DCR_CLIENT_PREFIX.length),
	) as Partial<SealedClient> | null
	if (
		!value ||
		value.v !== 1 ||
		typeof value.n !== 'string' ||
		!Array.isArray(value.r) ||
		!value.r.every(isAllowedRedirectUri)
	)
		return null
	return {
		clientId,
		clientName: value.n,
		redirectUris: value.r,
		kind: 'dcr',
		clientHost: hostOf(value.r[0] ?? ''),
	}
}

/** Validates a fetched metadata document against the URL it came from. */
export function clientFromMetadataDocument(
	clientId: string,
	document: unknown,
): OAuthClient | null {
	if (!document || typeof document !== 'object' || Array.isArray(document))
		return null
	const doc = document as Record<string, unknown>
	if (doc.client_id !== clientId) return null
	const clientName = cleanClientName(doc.client_name)
	const uris = doc.redirect_uris
	if (
		!clientName ||
		!Array.isArray(uris) ||
		uris.length === 0 ||
		!uris.every(isAllowedRedirectUri)
	)
		return null
	return {
		clientId,
		clientName,
		redirectUris: uris,
		kind: 'cimd',
		clientHost: hostOf(clientId),
	}
}

const CACHE_LIMIT = 200
const cimdCache = new Map<string, { client: OAuthClient; until: number }>()

function remember(client: OAuthClient, maxAgeSeconds: number) {
	if (maxAgeSeconds <= 0) return
	if (cimdCache.size >= CACHE_LIMIT) {
		const oldest = cimdCache.keys().next().value
		if (oldest !== undefined) cimdCache.delete(oldest)
	}
	cimdCache.set(client.clientId, {
		client,
		until: Date.now() + maxAgeSeconds * 1000,
	})
}

/** Tests only. */
export const clearClientCache = () => cimdCache.clear()

export type ClientResolution =
	| { ok: true; client: OAuthClient }
	| { ok: false; reason: string }

export async function resolveOAuthClient(
	clientId: unknown,
	fetchDocument: (
		url: string,
	) => Promise<CimdFetchResult> = fetchClientMetadataDocument,
): Promise<ClientResolution> {
	if (typeof clientId !== 'string' || !clientId)
		return { ok: false, reason: 'missing' }

	if (clientId.startsWith(DCR_CLIENT_PREFIX)) {
		const client = openDcrClientId(clientId)
		return client ? { ok: true, client } : { ok: false, reason: 'bad-dcr-id' }
	}

	if (!clientId.startsWith('https://'))
		return { ok: false, reason: 'unknown-client' }

	const cached = cimdCache.get(clientId)
	if (cached && cached.until > Date.now())
		return { ok: true, client: cached.client }

	const host = hostOf(clientId)
	if (!(await oauthRateLimit('cimd-host', host)))
		return { ok: false, reason: 'cimd-rate-limited' }

	const fetched = await fetchDocument(clientId)
	if (!fetched.ok) {
		void log.warn('learner_agent.oauth', {
			outcome: 'cimd_fetch_failed',
			clientHost: host,
			reason: fetched.reason,
		})
		return { ok: false, reason: `cimd-${fetched.reason}` }
	}
	const client = clientFromMetadataDocument(clientId, fetched.document)
	if (!client) {
		void log.warn('learner_agent.oauth', {
			outcome: 'cimd_invalid',
			clientHost: host,
		})
		return { ok: false, reason: 'cimd-invalid' }
	}
	remember(client, fetched.maxAgeSeconds)
	return { ok: true, client }
}
