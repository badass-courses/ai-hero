import { NextResponse } from 'next/server'
import {
	buildLlmsTxtDocument,
	DISCOVERY_CACHE_CONTROL,
} from '@/lib/agent-discovery'

export async function GET() {
	return new NextResponse(buildLlmsTxtDocument(), {
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': DISCOVERY_CACHE_CONTROL,
		},
	})
}
