import { learnerAgentPortsFor } from '@/lib/learner-agent/ports'

import { makeLearnerAgent } from '@ai-hero/learner-agent'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * The learner MCP server: stateless streamable HTTP, one JSON-RPC message
 * or batch per POST. Tools, prompts and schemas come from
 * `@ai-hero/learner-agent`; this route only builds the request's ports.
 */
export async function POST(request: Request) {
	return makeLearnerAgent(await learnerAgentPortsFor(request)).handleMcp(
		request,
	)
}

/** No server-to-client stream: this server never pushes. */
export async function GET() {
	return new Response(null, { status: 405, headers: { Allow: 'POST' } })
}

export const DELETE = GET
