import { NextResponse } from 'next/server'
import {
	mintDcrClientId,
	parseRegistration,
} from '@/lib/learner-agent/oauth/client'
import {
	corsPreflight,
	oauthError,
	oauthJson,
} from '@/lib/learner-agent/oauth/metadata'
import { oauthRateLimit } from '@/lib/learner-agent/oauth/rate-limit'
import { requestIp } from '@/lib/learner-agent/rate-limit'
import { nowSeconds } from '@/lib/learner-agent/oauth/sealed'
import { log } from '@/server/logger'
import { customAlphabet } from 'nanoid'

const nanoid = customAlphabet('ABCDEFGHIJKLMNOP', 6)

async function jsonBody(request: Request) {
	if (!request.headers.get('content-type')?.includes('application/json'))
		return null
	const body = (await request.json().catch(() => null)) as unknown
	return body && typeof body === 'object' && !Array.isArray(body)
		? (body as Record<string, unknown>)
		: null
}

/**
 * Client registration. A request with RFC 7591 metadata (`redirect_uris`)
 * gets a stateless public client for the authorization code flow: its
 * `client_id` seals the name and redirect URIs, so nothing is stored.
 * Anything else gets the device flow's demo response, unchanged.
 */
export async function POST(request: Request) {
	const body = await jsonBody(request)
	if (!body || !('redirect_uris' in body)) {
		return NextResponse.json(
			{
				client_id: nanoid(),
				client_secret: nanoid(),
			},
			{ status: 201 },
		)
	}

	if (!(await oauthRateLimit('register', requestIp(request))))
		return oauthError(
			'slow_down',
			'Too many registrations. Try again in a minute.',
			429,
		)

	const parsed = parseRegistration(body)
	if (!parsed.ok) return oauthError(parsed.error, parsed.description)

	const clientId = mintDcrClientId(parsed.clientName, parsed.redirectUris)
	if (!clientId)
		return oauthError('server_error', 'Registration is unavailable.', 503)

	void log.info('learner_agent.oauth', {
		outcome: 'client_registered',
		clientHost: new URL(parsed.redirectUris[0] as string).host,
	})
	return oauthJson(
		{
			client_id: clientId,
			client_id_issued_at: nowSeconds(),
			client_name: parsed.clientName,
			redirect_uris: parsed.redirectUris,
			grant_types: ['authorization_code'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
			scope: 'learner:read',
		},
		201,
	)
}

export const OPTIONS = corsPreflight
