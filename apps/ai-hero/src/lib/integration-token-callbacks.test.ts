import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptIntegrationToken } from './integration-token-crypto'

const mocks = vi.hoisted(() => ({
	env: { INTEGRATION_TOKEN_KEY: undefined as string | undefined },
	getToken: vi.fn(),
	setCredentials: vi.fn(),
	generateAuthUrl: vi.fn(),
	insert: vi.fn(),
	limit: vi.fn(),
	fetch: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	flush: vi.fn(),
}))
vi.mock('@/env.mjs', () => ({ env: mocks.env }))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: async () => ({ ability: { cannot: () => false } }),
}))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))
vi.mock('@/server/logger', async () => ({
	log: {
		info: mocks.info,
		warn: mocks.warn,
		error: mocks.error,
		flush: mocks.flush,
	},
	serializeError: (await import('@/server/logger-utils')).serializeError,
}))
vi.mock('@/db', () => ({
	db: {
		insert: mocks.insert,
		select: () => ({ from: () => ({ where: () => ({ limit: mocks.limit }) }) }),
	},
}))
vi.mock('google-auth-library', () => ({
	OAuth2Client: class {
		getToken = mocks.getToken
		setCredentials = mocks.setCredentials
		generateAuthUrl = mocks.generateAuthUrl
	},
}))
vi.mock('googleapis', () => ({
	google: {
		youtube: () => ({
			channels: {
				list: async () => ({
					data: {
						items: [{ id: 'channel', snippet: { title: 'Synthetic channel' } }],
					},
				}),
			},
			liveBroadcasts: { list: async () => ({ data: { items: [] } }) },
		}),
	},
}))
import { GET } from '@/app/api/analytics/youtube-auth/route'

const key = Buffer.alloc(32, 7)
const scopes =
	'https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly'
function callback() {
	return new NextRequest(
		'https://example.test/api/analytics/youtube-auth?code=synthetic-code&state=private-oauth-state',
		{ headers: { cookie: 'youtube_auth_state=private-oauth-state' } },
	)
}

describe('YouTube callback dual-write dormancy', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.env.INTEGRATION_TOKEN_KEY = undefined
		for (const [name, value] of Object.entries({
			YOUTUBE_OAUTH_CLIENT_ID: 'client',
			YOUTUBE_OAUTH_CLIENT_SECRET: 'secret',
			YOUTUBE_ANALYTICS_REFRESH_TOKEN: 'env-youtube',
			VERCEL_API_TOKEN: 'synthetic-vercel',
			VERCEL_CB_PROJECT_ID: 'prj_test',
			VERCEL_TEAM_ID: 'team_test',
		}))
			vi.stubEnv(name, value)
		vi.stubGlobal('fetch', mocks.fetch)
		mocks.fetch.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({ access_token: 'access', scope: scopes }),
					{ status: 200 },
				),
		)
		mocks.getToken.mockResolvedValue({
			tokens: { refresh_token: 'fresh-youtube', scope: scopes },
		})
		mocks.insert.mockImplementation(() => {
			throw new Error('synthetic database failure')
		})
		mocks.generateAuthUrl.mockReturnValue('https://example.test/consent')
		vi.spyOn(console, 'info').mockImplementation(() => {})
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
	})
	afterEach(() => {
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it.each([undefined, key.toString('base64')])(
		'keeps the same callback success, 3 Vercel writes and redeploy with no key or a failed DB (%s)',
		async (value) => {
			mocks.env.INTEGRATION_TOKEN_KEY = value
			const response = await GET(callback())
			expect(response.status).toBe(200)
			expect(await response.text()).toContain(
				'Refresh token stored automatically',
			)
			expect(mocks.fetch).toHaveBeenCalledTimes(4)
			for (const [index, [url, options]] of mocks.fetch.mock.calls
				.slice(0, 3)
				.entries()) {
				expect(url).toBe(
					'https://api.vercel.com/v10/projects/prj_test/env?upsert=true&teamId=team_test',
				)
				expect(JSON.parse(options.body)).toEqual({
					key: 'YOUTUBE_ANALYTICS_REFRESH_TOKEN',
					value: 'fresh-youtube',
					target: [['production', 'preview', 'development'][index]],
					type: 'encrypted',
				})
			}
			const [url, options] = mocks.fetch.mock.calls[3]!
			expect(url).toBe(
				'https://api.vercel.com/v13/deployments?teamId=team_test',
			)
			expect(JSON.parse(options.body)).toEqual({
				name: 'ai-hero',
				target: 'production',
				gitSource: {
					type: 'github',
					repo: 'course-builder',
					ref: 'main',
					org: 'badass-courses',
				},
			})
			expect(mocks.insert).toHaveBeenCalledTimes(value ? 1 : 0)
			expect(
				JSON.stringify([
					mocks.info.mock.calls,
					mocks.warn.mock.calls,
					mocks.error.mock.calls,
				]),
			).not.toContain('fresh-youtube')
		},
	)
	it('escapes the token exchange error in HTML', async () => {
		mocks.getToken.mockRejectedValue(
			new Error('<script>"bad" & \'worse\'</script>'),
		)
		const html = await (await GET(callback())).text()
		expect(html).toContain(
			'&lt;script&gt;&quot;bad&quot; &amp; &#39;worse&#39;&lt;/script&gt;',
		)
		expect(html).not.toContain('<script>')
	})
	it('logs independent request IDs, never the OAuth state', async () => {
		await GET(callback())
		await GET(
			new NextRequest('https://example.test/api/analytics/youtube-auth'),
		)
		const logs = JSON.stringify(mocks.info.mock.calls)
		expect(logs).not.toContain('private-oauth-state')
		const redirect = mocks.info.mock.calls.find(
			([event]) => event === 'youtube-auth.start.redirecting',
		)
		expect(redirect?.[1].requestId).toMatch(/^[a-f0-9-]{36}$/)
	})
	it.each([false, true])(
		'verification uses the env with no key, or prefers the encrypted DB token (key=%s)',
		async (enabled) => {
			mocks.env.INTEGRATION_TOKEN_KEY = enabled
				? key.toString('base64')
				: undefined
			mocks.limit.mockResolvedValue([
				encryptIntegrationToken('youtube_analytics', 'db-youtube', key),
			])
			const response = await GET(
				new NextRequest(
					'https://example.test/api/analytics/youtube-auth?verify=1',
				),
			)
			expect(response.status).toBe(200)
			expect(mocks.setCredentials).toHaveBeenCalledWith({
				refresh_token: enabled ? 'db-youtube' : 'env-youtube',
			})
			expect(mocks.fetch.mock.calls[0]![1].body.get('refresh_token')).toBe(
				enabled ? 'db-youtube' : 'env-youtube',
			)
		},
	)
})
