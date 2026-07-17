import { NextResponse } from 'next/server'
import {
	DISCOVERY_CACHE_CONTROL,
	getDiscoveryBaseUrl,
} from '@/lib/agent-discovery'
import { buildAgentOpenApiDocument } from '@/lib/agent-openapi'

export async function GET() {
	return NextResponse.json(buildAgentOpenApiDocument(getDiscoveryBaseUrl()), {
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': DISCOVERY_CACHE_CONTROL,
		},
	})
}
