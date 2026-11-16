import { learnerAgentPortsFor } from '@/lib/learner-agent/ports'
import {
	RETIREMENT_COPY,
	siteUrlForCall,
	withNoticeOnHttpBody,
} from '@/lib/learner-agent/retirement'
import { readLearnerAgentStage } from '@/lib/learner-agent/retirement.server'
import { learnerSiteUrls } from '@/lib/learner-agent/site'

import { makeLearnerAgent } from '@ai-hero/learner-agent'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Context = { params: Promise<{ capability: string }> }

/**
 * The learner capabilities over HTTP, one path each: GET with query
 * parameters for read-only ones, POST with a JSON body for all. Same
 * contracts and handlers as `/mcp`; the OpenAPI is in `/api/openapi.json`.
 * Retired, every call answers 410 with where to read the content instead.
 */
async function handle(request: Request, { params }: Context) {
	const { capability } = await params
	const stage = await readLearnerAgentStage()
	if (stage === 'retired') return retired(request)
	const response = await makeLearnerAgent(
		await learnerAgentPortsFor(request),
	).handleHttp(request, capability)
	return stage === 'notice' ? withNotice(response) : response
}

async function retired(request: Request) {
	const query = Object.fromEntries(new URL(request.url).searchParams)
	const body: unknown =
		request.method === 'POST'
			? await request.json().catch(() => undefined)
			: undefined
	const args =
		typeof body === 'object' && body !== null && !Array.isArray(body)
			? (body as Record<string, unknown>)
			: query
	const url = siteUrlForCall(learnerSiteUrls().baseUrl, args)
	return Response.json(
		{ ok: false, error: 'retired', message: RETIREMENT_COPY.retired(url), url },
		{ status: 410, headers: { 'Cache-Control': 'private, no-store' } },
	)
}

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
	return new Response(JSON.stringify(withNoticeOnHttpBody(body)), {
		status: response.status,
		headers,
	})
}

export const GET = handle
export const POST = handle
