import {
	authorizationServerMetadata,
	corsPreflight,
	METADATA_HEADERS,
} from '@/lib/learner-agent/oauth/metadata'

export const dynamic = 'force-dynamic'

/**
 * RFC 8414 metadata for issuer `/oauth`, at its path-inserted URL. The root
 * `/.well-known/oauth-authorization-server` serves the same document for
 * clients written against the 2025-03-26 MCP spec, which look there first.
 */
export function GET() {
	return Response.json(authorizationServerMetadata(), {
		headers: METADATA_HEADERS,
	})
}

export const OPTIONS = corsPreflight
