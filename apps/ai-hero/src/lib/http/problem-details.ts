import { NextResponse } from 'next/server'

/**
 * RFC 9457 problem details, the vocabulary /api/drovr/intents speaks, so an
 * agent debugging drovr and ai-hero reads one shape.
 */
export const problem = (
	status: number,
	slug: string,
	title: string,
	detail: string,
	hint: string,
) =>
	NextResponse.json(
		{ type: `urn:aihero:problem:${slug}`, title, status, detail, hint },
		{ status, headers: { 'content-type': 'application/problem+json' } },
	)
