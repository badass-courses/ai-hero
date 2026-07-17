import { describe, expect, it, vi } from 'vitest'

import {
	buildSignupGapPreview,
	fetchKitSignupGapPageWithRetry,
	replaySignupGap,
	SignupGapSourceUnavailableError,
} from './signup-gap-recovery'

describe('signup-gap Kit source resilience', () => {
	it('retries Kit HTTP 500s three times with exponential backoff', async () => {
		const request = vi
			.fn<[number], Promise<Response>>()
			.mockResolvedValueOnce(new Response('{}', { status: 500 }))
			.mockResolvedValueOnce(new Response('{}', { status: 502 }))
			.mockResolvedValueOnce(new Response('{}', { status: 200 }))
		const sleep = vi.fn<[number], Promise<void>>()
			.mockResolvedValue(undefined)

		const response = await fetchKitSignupGapPageWithRetry({
			request,
			backoffMs: 10,
			sleep,
		})

		expect(response.status).toBe(200)
		expect(request).toHaveBeenCalledTimes(3)
		expect(request.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 3])
		expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
			10,
			20,
		])
	})

	it('reports a typed source-unavailable error after the third Kit 500', async () => {
		const request = vi.fn(async () => new Response('{}', { status: 500 }))

		await expect(
			fetchKitSignupGapPageWithRetry({
				request,
				backoffMs: 0,
				sleep: async () => undefined,
			}),
		).rejects.toEqual(
			expect.objectContaining<Partial<SignupGapSourceUnavailableError>>({
				name: 'SignupGapSourceUnavailableError',
				attempts: 3,
				statusCode: 500,
			}),
		)
		expect(request).toHaveBeenCalledTimes(3)
	})
})

describe('signup-gap liveness metrics', () => {
	it('reports work seen, work done, and the oldest unserved age through the replay seam', async () => {
		const preview = buildSignupGapPreview({
			formId: 9376133,
			from: '2026-07-17T08:00:00.000Z',
			to: '2026-07-17T12:00:00.000Z',
			now: '2026-07-17T14:00:00.000Z',
			identityMatches: {
				contactEmails: new Set(),
				kitSubscriberIds: new Set(),
			},
			subscribers: [
				{
					kitSubscriberId: 'kit-oldest',
					email: 'oldest@example.com',
					createdAt: '2026-07-17T08:00:00.000Z',
				},
				{
					kitSubscriberId: 'kit-known-later',
					email: 'known@example.com',
					createdAt: '2026-07-17T10:00:00.000Z',
				},
			],
		})
		const emitted: unknown[] = []

		const receipt = await replaySignupGap({
			preview,
			hasExistingIdentity: async (candidate) =>
				candidate.kitSubscriberId === 'kit-known-later',
			emit: async (event) => {
				emitted.push(event)
			},
		})

		expect(preview).toMatchObject({
			workSeen: 2,
			workDone: 0,
			oldestUnservedAgeHours: 6,
			oldestUnservedAt: '2026-07-17T08:00:00.000Z',
		})
		expect(receipt).toMatchObject({
			generatedAt: '2026-07-17T14:00:00.000Z',
			workSeen: 2,
			workDone: 2,
			oldestUnservedAgeHours: null,
			oldestUnservedAt: null,
		})
		expect(emitted).toEqual([
			expect.objectContaining({
				data: expect.objectContaining({
					signupGapLiveness: {
						workSeen: 2,
						workDone: 2,
						oldestUnservedAgeHours: null,
						oldestUnservedAt: null,
					},
				}),
			}),
		])
	})
})
