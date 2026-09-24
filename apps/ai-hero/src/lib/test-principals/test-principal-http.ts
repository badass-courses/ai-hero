import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

/** RFC 9457 problem details, the vocabulary /api/drovr/intents speaks. */
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

/**
 * The test-principal bearer, compared in constant time. It is its own token,
 * never the executor's, so a leak of one cannot mint or send with the other.
 */
export function testPrincipalAuthProblem(
	header: string | null,
	secret: string | undefined,
): Response | undefined {
	if (!secret) {
		return problem(
			503,
			'test-principals-not-configured',
			'Test principals are not configured',
			'AIHERO_TEST_PRINCIPAL_TOKEN is not set on this deployment.',
			'Set the token in Vercel, then retry.',
		)
	}
	const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
	const left = Buffer.from(token)
	const right = Buffer.from(secret)
	if (!token || left.length !== right.length || !timingSafeEqual(left, right)) {
		return problem(
			401,
			'unauthorized',
			'Unauthorized',
			'The test-principal bearer token is missing or wrong.',
			'Send Authorization: Bearer <AIHERO_TEST_PRINCIPAL_TOKEN>.',
		)
	}
	return undefined
}
