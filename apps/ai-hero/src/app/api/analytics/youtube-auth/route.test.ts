import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getToken: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() },
}))
vi.mock('google-auth-library', () => ({
	OAuth2Client: class {
		getToken = mocks.getToken
	},
}))
vi.mock('googleapis', () => ({ google: {} }))
vi.mock('@/server/auth', () => ({ getServerAuthSession: vi.fn() }))
vi.mock('@/server/logger', () => ({
	log: mocks.log,
	serializeError: (error: unknown) => ({ message: String(error) }),
}))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))

import { GET } from './route'

function callback() {
	return new NextRequest(
		'https://example.test/api/analytics/youtube-auth?code=test-code&state=test-state',
		{
			headers: { cookie: 'youtube_auth_state=test-state' },
		},
	)
}
function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status })
}

describe('YouTube OAuth refresh token storage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.stubEnv('YOUTUBE_OAUTH_CLIENT_ID', 'test-client')
		vi.stubEnv('YOUTUBE_OAUTH_CLIENT_SECRET', 'test-secret')
		vi.stubEnv('VERCEL_API_TOKEN', 'test-token')
		vi.stubEnv('VERCEL_CB_PROJECT_ID', 'test-project')
		vi.stubEnv('VERCEL_TEAM_ID', 'test-team')
		mocks.getToken.mockResolvedValue({
			tokens: { refresh_token: 'fresh-test-token' },
		})
		vi.spyOn(console, 'info').mockImplementation(() => {})
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		// Fail closed on unmocked networking in every test.
		vi.stubGlobal(
			'fetch',
			vi.fn().mockRejectedValue(new Error('Unexpected fetch')),
		)
	})
	afterEach(() => {
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it('stores all three targets as sensitive Secrets before redeploying', async () => {
		const fetchMock = vi.fn().mockImplementation(async (url, options) => {
			if (String(url).includes('/v13/deployments')) return jsonResponse({})
			return jsonResponse(
				{ created: JSON.parse(options.body), failed: [] },
				201,
			)
		})
		vi.stubGlobal('fetch', fetchMock)
		const response = await GET(callback())
		expect(await response.text()).toContain(
			'Refresh token stored automatically',
		)
		expect(fetchMock).toHaveBeenCalledTimes(4)
		for (const [index, target] of [
			'production',
			'preview',
			'development',
		].entries()) {
			const [url, options] = fetchMock.mock.calls[index]
			expect(url).toContain(
				'/v10/projects/test-project/env?upsert=true&teamId=test-team',
			)
			expect(JSON.parse(options.body)).toEqual({
				key: 'YOUTUBE_ANALYTICS_REFRESH_TOKEN',
				value: 'fresh-test-token',
				target: [target],
				type: 'sensitive',
				visibility: 'secret',
			})
		}
		expect(fetchMock.mock.calls[3][0]).toContain('/v13/deployments')
	})

	it.each([
		'http-conflict',
		'unchanged-type',
		'partial-failure',
		'network-failure',
	])(
		'surfaces %s without redeploying, deleting, or logging tokens',
		async (failure) => {
			const fetchMock = vi.fn().mockImplementation(async (_url, options) => {
				const created = JSON.parse(options.body)
				if (created.target[0] !== 'preview')
					return jsonResponse({ created, failed: [] })
				if (failure === 'network-failure') throw new Error('fresh-test-token')
				if (failure === 'http-conflict')
					return jsonResponse({ error: { message: 'fresh-test-token' } }, 409)
				if (failure === 'unchanged-type')
					return jsonResponse({
						created: { ...created, type: 'encrypted' },
						failed: [],
					})
				return jsonResponse(
					{ created, failed: [{ error: { message: 'fresh-test-token' } }] },
					201,
				)
			})
			vi.stubGlobal('fetch', fetchMock)
			const response = await GET(callback())
			const html = await response.text()
			expect(html).toContain('token storage did not fully complete')
			expect(html).not.toContain('fresh-test-token')
			expect(fetchMock).toHaveBeenCalledTimes(3)
			expect(
				fetchMock.mock.calls.every(([, options]) => options.method === 'POST'),
			).toBe(true)
			expect(mocks.log.warn).toHaveBeenCalledWith(
				'youtube-auth.vercel-env-write.failed',
				expect.objectContaining({ target: 'preview' }),
			)
			for (const logger of [
				mocks.log.info,
				mocks.log.warn,
				mocks.log.error,
				console.info,
				console.warn,
				console.error,
			]) {
				expect(JSON.stringify(vi.mocked(logger).mock.calls)).not.toContain(
					'fresh-test-token',
				)
			}
		},
	)
})
