import { NextResponse } from 'next/server'
import {
	buildApiDiscoveryDocument,
	DISCOVERY_CACHE_CONTROL,
} from '@/lib/agent-discovery'

export async function GET() {
	return NextResponse.json(buildApiDiscoveryDocument(), {
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': DISCOVERY_CACHE_CONTROL,
		},
	})
}
