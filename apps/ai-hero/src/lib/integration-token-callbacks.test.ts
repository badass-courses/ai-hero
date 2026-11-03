import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptIntegrationToken } from './integration-token-crypto'

const mocks = vi.hoisted(() => ({
	env: { INTEGRATION_TOKEN_KEY: undefined as string | undefined },
	getToken: vi.fn(),
	setCredentials: vi.fn(),
	generateAuthUrl: vi.fn(),
	insert: vi.fn(),
	delete: vi.fn(),
	deleteWhere: vi.fn(),
	debug: vi.fn(),
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
		debug: mocks.debug,
		warn: mocks.warn,
		error: mocks.error,
		flush: mocks.flush,
	},
	serializeError: (await import('@/server/logger-utils')).serializeError,
}))
vi.mock('@/db', () => ({
	db: {
		insert: mocks.insert,
		delete: mocks.delete,
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
import { storeDropboxRefreshToken } from './dropbox-course-sync'

const key = Buffer.alloc(32, 7)
const scopes =
	'https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly'
function callback() {
	return new NextRequest(
		'https://example.test/api/analytics/youtube-auth?code=synthetic-code&state=private-oauth-state',
		{ headers: { cookie: 'youtube_auth_state=private-oauth-state' } },
	)
}

describe('OAuth callbacks store only in the DB', () => {
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
		mocks.delete.mockReturnValue({ where: mocks.deleteWhere })
		mocks.deleteWhere.mockResolvedValue(undefined)
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

	it('stores the YouTube token in the DB and makes no Vercel call', async () => {
		mocks.env.INTEGRATION_TOKEN_KEY = key.toString('base64')
		mocks.insert.mockReset()
		mocks.insert.mockReturnValue({
			values: () => ({ onDuplicateKeyUpdate: async () => undefined }),
		})
		const response = await GET(callback())
		expect(response.status).toBe(200)
		const html = await response.text()
		expect(html).toContain('Refresh token stored')
		expect(html).not.toContain('could not be saved')
		expect(mocks.insert).toHaveBeenCalledTimes(1)
		expect(mocks.fetch).not.toHaveBeenCalled()
		expect(mocks.delete).not.toHaveBeenCalled()
		expect(
			JSON.stringify([
				mocks.info.mock.calls,
				mocks.warn.mock.calls,
				mocks.error.mock.calls,
			]),
		).not.toContain('fresh-youtube')
	})
	it.each([undefined, key.toString('base64')])(
		'shows a visible error and makes no Vercel call when the YouTube put fails (key=%s)',
		async (value) => {
			mocks.env.INTEGRATION_TOKEN_KEY = value
			const response = await GET(callback())
			const html = await response.text()
			expect(html).toContain('YouTube token was not stored')
			expect(html).toContain('could not be saved')
			expect(html).not.toContain('using env')
			expect(html).not.toContain('Refresh token stored')
			expect(mocks.fetch).not.toHaveBeenCalled()
			expect(JSON.stringify(mocks.error.mock.calls)).not.toContain(
				'fresh-youtube',
			)
		},
	)
	it('stores the Dropbox token in the DB and makes no Vercel call', async () => {
		mocks.env.INTEGRATION_TOKEN_KEY = key.toString('base64')
		mocks.insert.mockReset()
		mocks.insert.mockReturnValue({
			values: () => ({ onDuplicateKeyUpdate: async () => undefined }),
		})
		expect(
			await storeDropboxRefreshToken({ refreshToken: 'fresh-dropbox' }),
		).toEqual({ ok: true })
		expect(mocks.insert).toHaveBeenCalledTimes(1)
		expect(mocks.fetch).not.toHaveBeenCalled()
	})
	it('reports a Dropbox put failure and makes no Vercel call', async () => {
		mocks.env.INTEGRATION_TOKEN_KEY = key.toString('base64')
		expect(
			await storeDropboxRefreshToken({ refreshToken: 'fresh-dropbox' }),
		).toEqual({ ok: false })
		expect(mocks.fetch).not.toHaveBeenCalled()
		expect(mocks.delete).not.toHaveBeenCalled()
	})

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
	it('verification ignores env and reads only the encrypted DB token', async () => {
		mocks.env.INTEGRATION_TOKEN_KEY = key.toString('base64')
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
			refresh_token: 'db-youtube',
		})
	})
})
