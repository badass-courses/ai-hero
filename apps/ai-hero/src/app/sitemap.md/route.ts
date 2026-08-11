import { NextResponse } from 'next/server'
import {
	buildSitemapMarkdownDocument,
	DISCOVERY_CACHE_CONTROL,
	getPublicDiscoveryResources,
} from '@/lib/agent-discovery'

export const revalidate = 3600
export const dynamic = 'force-static'

/**
 * sitemap.md - AI agent discovery endpoint
 * Returns a markdown discovery index of free public content and route guidance.
 */
export async function GET() {
	const resources = await getPublicDiscoveryResources()
	const markdown = buildSitemapMarkdownDocument({ resources })

	return new NextResponse(markdown, {
		headers: {
			'Content-Type': 'text/markdown; charset=utf-8',
			'Cache-Control': DISCOVERY_CACHE_CONTROL,
		},
	})
}
