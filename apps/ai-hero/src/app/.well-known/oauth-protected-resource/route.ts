import {
	corsPreflight,
	METADATA_HEADERS,
	protectedResourceMetadata,
} from '@/lib/learner-agent/oauth/metadata'

export const dynamic = 'force-dynamic'

/**
 * RFC 9728 protected resource metadata for the learner MCP server. Served
 * here and at `/mcp`'s path-inserted URL, the one the 401 names.
 */
export function GET() {
	return Response.json(protectedResourceMetadata(), {
		headers: METADATA_HEADERS,
	})
}

export const OPTIONS = corsPreflight
