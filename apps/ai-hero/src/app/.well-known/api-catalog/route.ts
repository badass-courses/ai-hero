import {
	buildApiCatalogDocument,
	DISCOVERY_CACHE_CONTROL,
} from '@/lib/agent-discovery'

export const dynamic = 'force-static'
export const revalidate = 3600

export async function GET() {
	return new Response(JSON.stringify(buildApiCatalogDocument(), null, 2), {
		headers: {
			'Cache-Control': DISCOVERY_CACHE_CONTROL,
			'Content-Type': 'application/linkset+json',
		},
	})
}
