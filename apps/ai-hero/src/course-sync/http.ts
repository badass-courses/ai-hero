import { timingSafeEqual } from 'node:crypto'
import { env } from '@/env.mjs'

import { CourseSyncError, asCourseSyncError } from './errors'

export type CourseSyncRole = 'read' | 'stage' | 'worker' | 'operator'

function sameSecret(actual: string, expected: string) {
	const actualBytes = Buffer.from(actual)
	const expectedBytes = Buffer.from(expected)
	return (
		actualBytes.length === expectedBytes.length &&
		timingSafeEqual(actualBytes, expectedBytes)
	)
}

export function authorizeCourseSyncRequest(
	request: Request,
	role: CourseSyncRole | ReadonlyArray<CourseSyncRole>,
) {
	const configured = {
		stage: env.COURSE_SYNC_STAGE_TOKEN,
		worker: env.COURSE_SYNC_WORKER_TOKEN,
		operator: env.COURSE_SYNC_OPERATOR_TOKEN,
	}
	const roles: ReadonlyArray<CourseSyncRole> =
		typeof role === 'string' ? [role] : role
	const allowed = roles.flatMap((candidate) =>
		candidate === 'read'
			? [configured.stage, configured.worker, configured.operator]
			: [configured[candidate]],
	)
	const expected = allowed.filter((token): token is string => Boolean(token))
	if (expected.length === 0) {
		throw new CourseSyncError(
			'COURSE_SYNC_AUTH_NOT_CONFIGURED',
			'Course sync service authentication is not configured.',
			503,
		)
	}
	const authorization = request.headers.get('authorization')
	const token = authorization?.startsWith('Bearer ')
		? authorization.slice('Bearer '.length)
		: ''
	if (!token || !expected.some((candidate) => sameSecret(token, candidate))) {
		throw new CourseSyncError('COURSE_SYNC_UNAUTHORIZED', 'Unauthorized.', 401)
	}
}

export function idempotencyKey(request: Request) {
	const value = request.headers.get('idempotency-key')?.trim()
	if (!value) {
		throw new CourseSyncError(
			'IDEMPOTENCY_KEY_REQUIRED',
			'Idempotency-Key is required.',
			400,
		)
	}
	return value
}

export function courseSyncErrorResponse(error: unknown) {
	const failure = asCourseSyncError(error)
	return Response.json(
		{
			error: {
				code: failure.code,
				message:
					failure.status >= 500
						? 'Course sync operation failed.'
						: failure.message,
				...(failure.status < 500
					? {
							retryable: failure.retryable,
							details: failure.details ?? null,
						}
					: {}),
			},
		},
		{ status: failure.status, headers: { 'Cache-Control': 'no-store' } },
	)
}

export function courseSyncJson(value: unknown, status = 200) {
	return Response.json(value, {
		status,
		headers: { 'Cache-Control': 'no-store' },
	})
}
