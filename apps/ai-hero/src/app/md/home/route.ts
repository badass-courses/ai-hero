import {
	buildHomepageMarkdownDocument,
	DISCOVERY_CACHE_CONTROL,
} from '@/lib/agent-discovery'

export async function GET() {
	return new Response(buildHomepageMarkdownDocument(), {
		headers: {
			'Cache-Control': DISCOVERY_CACHE_CONTROL,
			'Content-Type': 'text/markdown; charset=utf-8',
		},
	})
}
