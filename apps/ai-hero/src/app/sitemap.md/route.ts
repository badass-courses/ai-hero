import { NextResponse } from 'next/server'
import {
	buildSitemapMarkdownDocument,
	DISCOVERY_CACHE_CONTROL,
	getPublicDiscoveryResources,
} from '@/lib/agent-discovery'

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
