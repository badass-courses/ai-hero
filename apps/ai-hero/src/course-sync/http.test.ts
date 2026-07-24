import { describe, expect, it } from 'vitest'

import {
	authorizeCourseSyncRequest,
	courseSyncErrorResponse,
} from './http'

function request(token: string) {
	return new Request('https://www.aihero.dev/v1/course-sync', {
		headers: { Authorization: `Bearer ${token}` },
	})
}

describe('course sync service roles', () => {
	it('keeps stage, worker apply, and operator rollback credentials separate', () => {
		expect(() =>
			authorizeCourseSyncRequest(
				request('test-stage-token-1234567890'),
				'stage',
			),
		).not.toThrow()
		expect(() =>
			authorizeCourseSyncRequest(
				request('test-stage-token-1234567890'),
				'worker',
			),
		).toThrow('Unauthorized')
		expect(() =>
			authorizeCourseSyncRequest(
				request('test-worker-token-123456789'),
				'worker',
			),
		).not.toThrow()
		expect(() =>
			authorizeCourseSyncRequest(
				request('test-worker-token-123456789'),
				'operator',
			),
		).toThrow('Unauthorized')
		expect(() =>
			authorizeCourseSyncRequest(
				request('test-operator-token-1234567'),
				'operator',
			),
		).not.toThrow()
	})

	it('does not expose internal provider or database failure text', async () => {
		const response = courseSyncErrorResponse(
			new Error('private provider token failed in secret bucket'),
		)
		const body = await response.json()
		expect(response.status).toBe(500)
		expect(JSON.stringify(body)).not.toContain('private provider')
		expect(body).toEqual({
			error: {
				code: 'COURSE_SYNC_INTERNAL_ERROR',
				message: 'Course sync operation failed.',
			},
		})
	})
})
