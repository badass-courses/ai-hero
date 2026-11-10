import { learnerAgentPortsFor } from '@/lib/learner-agent/ports'

import { makeLearnerAgent } from '@ai-hero/learner-agent'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Context = { params: Promise<{ capability: string }> }

/**
 * The learner capabilities over HTTP, one path each: GET with query
 * parameters for read-only ones, POST with a JSON body for all. Same
 * contracts and handlers as `/mcp`; the OpenAPI is in `/api/openapi.json`.
 */
async function handle(request: Request, { params }: Context) {
	const { capability } = await params
	return makeLearnerAgent(await learnerAgentPortsFor(request)).handleHttp(
		request,
		capability,
	)
}

export const GET = handle
export const POST = handle
