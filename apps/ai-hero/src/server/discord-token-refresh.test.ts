import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	DISCORD_REFRESH_ATTEMPT_TIMEOUT_MS,
	DISCORD_REFRESH_TOTAL_TIMEOUT_MS,
	getDiscordRefreshAccountUpdate,
	refreshDiscordAccessToken,
} from './discord-token-refresh'

function response({
	status,
	body,
}: {
	status: number
	body: unknown
}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	}
}

const input = {
	clientId: 'discord-client',
	clientSecret: 'discord-secret',
	refreshToken: 'private-refresh-token',
}

describe('Discord token refresh', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('transitions an invalid grant to reconnect-required without retrying', async () => {
		const fetchToken = vi.fn(async () =>
			response({ status: 400, body: { error: 'invalid_grant' } }),
		)

		const result = await refreshDiscordAccessToken({ ...input, fetchToken })

		expect(result).toEqual({
			status: 'reconnect-required',
			reasonCode: 'invalid-grant',
			attempts: 1,
		})
		expect(getDiscordRefreshAccountUpdate(result, 1_700_000_000)).toEqual({
			access_token: null,
			expires_at: null,
			refresh_token: null,
		})
		expect(fetchToken).toHaveBeenCalledOnce()
	})

	it('retries a transient response and returns the refreshed credentials', async () => {
		const fetchToken = vi
			.fn()
			.mockResolvedValueOnce(
				response({
					status: 400,
					body: { error: 'temporarily_unavailable' },
				}),
			)
			.mockResolvedValueOnce(
				response({
					status: 200,
					body: {
						access_token: 'new-access-token',
						refresh_token: 'new-refresh-token',
						expires_in: 3600,
					},
				}),
			)
		const sleep = vi.fn(async () => {})

		await expect(
			refreshDiscordAccessToken({ ...input, fetchToken, sleep }),
		).resolves.toEqual({
			status: 'refreshed',
			accessToken: 'new-access-token',
			refreshToken: 'new-refresh-token',
			expiresIn: 3600,
			attempts: 2,
		})
		expect(fetchToken).toHaveBeenCalledTimes(2)
		expect(sleep).toHaveBeenCalledOnce()
	})

	it('times out one provider attempt before retrying successfully', async () => {
		vi.useFakeTimers()
		const aborted = vi.fn()
		const fetchToken = vi
			.fn()
			.mockImplementationOnce(
				(_url: string, init: RequestInit) =>
					new Promise<ReturnType<typeof response>>((_resolve, reject) => {
						init.signal?.addEventListener('abort', () => {
							aborted()
							reject(new Error('provider request aborted'))
						})
					}),
			)
			.mockResolvedValueOnce(
				response({
					status: 200,
					body: {
						access_token: 'new-access-token',
						refresh_token: 'new-refresh-token',
						expires_in: 3600,
					},
				}),
			)

		const resultPromise = refreshDiscordAccessToken({ ...input, fetchToken })
		await vi.advanceTimersByTimeAsync(DISCORD_REFRESH_ATTEMPT_TIMEOUT_MS + 100)

		await expect(resultPromise).resolves.toEqual({
			status: 'refreshed',
			accessToken: 'new-access-token',
			refreshToken: 'new-refresh-token',
			expiresIn: 3600,
			attempts: 2,
		})
		expect(aborted).toHaveBeenCalledOnce()
		expect(fetchToken).toHaveBeenCalledTimes(2)
		expect(fetchToken.mock.calls[0]?.[1].signal?.aborted).toBe(true)
	})

	it('bounds total provider wall clock when every attempt hangs', async () => {
		vi.useFakeTimers()
		const fetchToken = vi.fn(
			(_url: string, init: RequestInit) =>
				new Promise<ReturnType<typeof response>>((_resolve, reject) => {
					init.signal?.addEventListener('abort', () => {
						reject(new Error('provider request aborted'))
					})
				}),
		)
		const startedAt = Date.now()

		const resultPromise = refreshDiscordAccessToken({ ...input, fetchToken })
		await vi.advanceTimersByTimeAsync(DISCORD_REFRESH_TOTAL_TIMEOUT_MS)

		await expect(resultPromise).resolves.toEqual({
			status: 'failed',
			reasonCode: 'time-budget-exhausted',
			attempts: 3,
			lastStatus: null,
		})
		expect(Date.now() - startedAt).toBe(DISCORD_REFRESH_TOTAL_TIMEOUT_MS)
		expect(fetchToken).toHaveBeenCalledTimes(3)
		for (const [, request] of fetchToken.mock.calls) {
			expect(request.signal?.aborted).toBe(true)
		}
	})

	it('bounds transient retries', async () => {
		const fetchToken = vi.fn(async () =>
			response({ status: 503, body: { error: 'server_error' } }),
		)
		const sleep = vi.fn(async () => {})

		await expect(
			refreshDiscordAccessToken({ ...input, fetchToken, sleep }),
		).resolves.toEqual({
			status: 'failed',
			reasonCode: 'retry-exhausted',
			attempts: 3,
			lastStatus: 503,
		})
		expect(fetchToken).toHaveBeenCalledTimes(3)
		expect(sleep).toHaveBeenCalledTimes(2)
		expect(
			getDiscordRefreshAccountUpdate(
				{
					status: 'failed',
					reasonCode: 'retry-exhausted',
					attempts: 3,
					lastStatus: 503,
				},
				1_700_000_000,
			),
		).toBeNull()
	})

	it('does not retry a permanent 400 response', async () => {
		const fetchToken = vi.fn(async () =>
			response({ status: 400, body: { error: 'invalid_request' } }),
		)

		await expect(
			refreshDiscordAccessToken({ ...input, fetchToken }),
		).resolves.toEqual({
			status: 'failed',
			reasonCode: 'invalid-request',
			attempts: 1,
			lastStatus: 400,
		})
		expect(fetchToken).toHaveBeenCalledOnce()
	})

	it('requires reconnect without making a request when no refresh token exists', async () => {
		const fetchToken = vi.fn()

		await expect(
			refreshDiscordAccessToken({ ...input, refreshToken: null, fetchToken }),
		).resolves.toEqual({
			status: 'reconnect-required',
			reasonCode: 'missing-refresh-token',
			attempts: 0,
		})
		expect(fetchToken).not.toHaveBeenCalled()
	})

	it('returns only allowlisted failure data', async () => {
		const privateValues = [
			'private-refresh-token',
			'customer@example.com',
			'provider-account-123',
		]
		const fetchToken = vi.fn(async () =>
			response({
				status: 400,
				body: {
					error: privateValues[1],
					error_description: privateValues.join(' '),
				},
			}),
		)

		const result = await refreshDiscordAccessToken({ ...input, fetchToken })
		const serialized = JSON.stringify(result)

		expect(result).toEqual({
			status: 'failed',
			reasonCode: 'provider-rejected',
			attempts: 1,
			lastStatus: 400,
		})
		for (const value of privateValues) {
			expect(serialized).not.toContain(value)
		}
	})
})
