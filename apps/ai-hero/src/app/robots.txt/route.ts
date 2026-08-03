import { buildRobotsTxt } from '@/lib/robots-config'

/**
 * Serves robots.txt with wildcard and named AI-crawler groups, Content
 * Signals, and sitemap directives. A plain route (rather than the Next
 * metadata API) because MetadataRoute.Robots cannot emit Content-Signal
 * lines.
 */
export async function GET() {
	return new Response(buildRobotsTxt(), {
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
		},
	})
}
