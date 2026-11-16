import { resolveBearer } from '@/lib/learner-agent/identity'
import { learnerSignInChallenge } from '@/lib/learner-agent/oauth/metadata'
import { learnerAgentPortsFor } from '@/lib/learner-agent/ports'
import {
	answerRetiredToolCalls,
	withNoticeOnToolResults,
} from '@/lib/learner-agent/retirement'
import { readLearnerAgentStage } from '@/lib/learner-agent/retirement.server'
import { learnerSiteUrls } from '@/lib/learner-agent/site'
import { DEVICE_LOGIN_EXPIRED_MESSAGE } from '@/server/device-access-token'

import { makeLearnerAgent } from '@ai-hero/learner-agent'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * The learner MCP server: stateless streamable HTTP, one JSON-RPC message
 * or batch per POST. Tools, prompts and schemas come from
 * `@ai-hero/learner-agent`; this route only builds the request's ports.
 *
 * Auth (MCP authorization, option B): an anonymous caller keeps the public
 * tools, and a learner-only call answers 401 with a `WWW-Authenticate`
 * challenge naming the protected resource metadata, so an OAuth client
 * signs in. A token that does not resolve (unknown, expired, revoked, or
 * minted for something else) always answers 401, never the public subset.
 */
export async function POST(request: Request) {
	const stage = await readLearnerAgentStage()
	if (stage === 'retired') return retiredPost(request)
	const response = await livePost(request)
	return stage === 'notice' ? withNotice(response) : response
}

/**
 * Retired: tool calls get the retirement message and a link to the same
 * content on the site, before any token check, so even a revoked token sees
 * it instead of a sign-in loop. `initialize`, `tools/list` and notifications
 * still answer, anonymously, so the client keeps working well enough to show
 * the message.
 */
async function retiredPost(request: Request) {
	const body: unknown = await request
		.clone()
		.json()
		.catch(() => undefined)
	if (body === undefined) return anonymousAgent(request)
	const { answered, rest, batch } = answerRetiredToolCalls(
		body,
		learnerSiteUrls().baseUrl,
	)
	if (!answered.length) return anonymousAgent(request)
	let forwarded: unknown[] = []
	if (rest.length) {
		const response = await anonymousAgent(
			new Request(request.url, {
				method: 'POST',
				headers: request.headers,
				body: JSON.stringify(batch ? rest : rest[0]),
			}),
		)
		const parsed: unknown = await response.json().catch(() => undefined)
		forwarded = parsed === undefined ? [] : [parsed].flat()
	}
	const messages = [...answered, ...forwarded]
	return Response.json(batch ? messages : messages[0], {
		headers: { 'Cache-Control': 'private, no-store' },
	})
}

async function anonymousAgent(request: Request) {
	return makeLearnerAgent(await learnerAgentPortsFor(request, null)).handleMcp(
		request,
		{},
	)
}

/** Notice: the live response, with the notice added to every tool result. */
async function withNotice(response: Response) {
	if (!response.headers.get('content-type')?.includes('application/json'))
		return response
	const body: unknown = await response
		.clone()
		.json()
		.catch(() => undefined)
	if (body === undefined) return response
	const headers = new Headers(response.headers)
	headers.delete('content-length')
	return new Response(JSON.stringify(withNoticeOnToolResults(body)), {
		status: response.status,
		headers,
	})
}

async function livePost(request: Request) {
	const caller = await resolveBearer(request)
	if (caller.kind === 'invalid') {
		return Response.json(
			{
				jsonrpc: '2.0',
				id: null,
				error: {
					code: -32001,
					message: DEVICE_LOGIN_EXPIRED_MESSAGE,
				},
			},
			{
				status: 401,
				headers: {
					'Cache-Control': 'private, no-store',
					'WWW-Authenticate': learnerSignInChallenge({
						error: 'invalid_token',
						description: DEVICE_LOGIN_EXPIRED_MESSAGE,
					}),
				},
			},
		)
	}

	const learner = caller.kind === 'learner' ? caller.learner : null
	return makeLearnerAgent(
		await learnerAgentPortsFor(request, learner),
	).handleMcp(
		request,
		learner ? {} : { signInChallenge: learnerSignInChallenge() },
	)
}

/** No server-to-client stream: this server never pushes. */
export async function GET() {
	return new Response(null, { status: 405, headers: { Allow: 'POST' } })
}

export const DELETE = GET
