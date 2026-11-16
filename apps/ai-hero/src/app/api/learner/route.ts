import { buildLearnerAgentGuide } from '@/lib/learner-agent/guide'
import { RETIREMENT_COPY } from '@/lib/learner-agent/retirement'
import { readLearnerAgentStage } from '@/lib/learner-agent/retirement.server'
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
	const stage = await readLearnerAgentStage()
	if (stage !== 'active') {
		const message =
			stage === 'retired'
				? RETIREMENT_COPY.retired(site.baseUrl)
				: `${RETIREMENT_COPY.notice} ${RETIREMENT_COPY.signInClosed}`
		const headers = { 'Cache-Control': 'no-store', Vary: 'Accept' }
		return request.headers.get('accept')?.includes('application/json')
			? Response.json({ stage, message }, { headers })
			: new Response(`# AI Hero agent connection\n\n${message}\n`, {
					headers: {
						'Content-Type': 'text/markdown; charset=utf-8',
						...headers,
					},
				})
	}
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
