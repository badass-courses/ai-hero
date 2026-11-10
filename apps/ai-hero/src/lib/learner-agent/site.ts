import { env } from '@/env.mjs'

import type { SiteUrls } from '@ai-hero/learner-agent'

export function learnerSiteUrls(
	baseUrl = env.NEXT_PUBLIC_URL || 'https://www.aihero.dev',
): SiteUrls {
	const base = baseUrl.replace(/\/+$/, '')
	return {
		baseUrl: base,
		connectUrl: `${base}/api/learner#sign-in`,
		instructionsUrl: `${base}/api/learner`,
		mcpUrl: `${base}/mcp`,
	}
}
