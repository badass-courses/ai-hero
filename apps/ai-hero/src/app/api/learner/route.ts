import { buildLearnerAgentGuide } from '@/lib/learner-agent/guide'
import { learnerSiteUrls } from '@/lib/learner-agent/site'

import { learnerCatalog } from '@ai-hero/learner-agent'

// Dynamic so the Accept header is visible; the CDN still caches by it.
export const dynamic = 'force-dynamic'

const CACHE = { 'Cache-Control': 'public, s-maxage=3600', Vary: 'Accept' }

/**
 * The learner agent guide: how to connect, sign in and work a course as a
 * study companion. Markdown by default; JSON catalog for `Accept:
 * application/json`.
 */
export async function GET(request: Request) {
	const site = learnerSiteUrls()
	if (request.headers.get('accept')?.includes('application/json')) {
		return Response.json(
			{ ...learnerCatalog(), mcpUrl: site.mcpUrl, guide: site.instructionsUrl },
			{ headers: CACHE },
		)
	}
	return new Response(buildLearnerAgentGuide(site), {
		headers: {
			'Content-Type': 'text/markdown; charset=utf-8',
			...CACHE,
		},
	})
}
