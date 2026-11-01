import { resolveBearer } from '@/lib/learner-agent/identity'
import { learnerSignInChallenge } from '@/lib/learner-agent/oauth/metadata'
import { learnerAgentPortsFor } from '@/lib/learner-agent/ports'

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
	const caller = await resolveBearer(request)
	if (caller.kind === 'invalid') {
		return Response.json(
			{
				jsonrpc: '2.0',
				id: null,
				error: {
					code: -32001,
					message:
						'This token is invalid, expired or revoked. Sign in again to get a new one.',
				},
			},
			{
				status: 401,
				headers: {
					'Cache-Control': 'private, no-store',
					'WWW-Authenticate': learnerSignInChallenge({
						error: 'invalid_token',
						description: 'The access token is invalid, expired or revoked',
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
