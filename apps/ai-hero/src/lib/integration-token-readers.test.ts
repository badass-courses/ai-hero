import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptIntegrationToken } from './integration-token-crypto'

const mocks = vi.hoisted(() => ({
	env: {
		INTEGRATION_TOKEN_KEY: undefined as string | undefined,
		DROPBOX_REFRESH_TOKEN: 'env-dropbox' as string | undefined,
		YOUTUBE_ANALYTICS_REFRESH_TOKEN: 'env-youtube' as string | undefined,
		YOUTUBE_OAUTH_CLIENT_ID: 'client',
		YOUTUBE_OAUTH_CLIENT_SECRET: 'secret',
		NEXTAUTH_SECRET: 'signing-secret',
		NEXT_PUBLIC_URL: 'https://example.test',
	},
	limit: vi.fn(),
	credentials: vi.fn(),
	mux: vi.fn(),
	asset: vi.fn(),
	verify: vi.fn(),
	summary: vi.fn(),
	fetch: vi.fn(),
	factory: undefined as unknown as (binding: unknown) => {
		resolve: (input: unknown) => Promise<unknown>
	},
}))
vi.mock('@/env.mjs', () => ({ env: mocks.env }))
vi.mock('@/db', () => ({
	db: {
		select: () => ({ from: () => ({ where: () => ({ limit: mocks.limit }) }) }),
	},
}))
vi.mock('@/server/logger', async () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() },
	serializeError: (await import('@/server/logger-utils')).serializeError,
}))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: async () => ({ ability: { can: () => true } }),
}))
vi.mock('@/server/ability-for-request', () => ({
	getUserAbilityForRequest: async () => ({
		user: { id: 'synthetic-admin' },
		ability: { can: () => true },
	}),
}))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))
vi.mock('@/lib/dropbox-course-sync', () => ({
	getDropboxSyncConfig: () => ({
		config: { source: { kind: 'shared-link' } },
		missingConfig: [],
	}),
	createDropboxSharedLinkAssetReader: mocks.asset,
	verifyDropboxConnection: mocks.verify,
	readDropboxCourseManifestSummary: mocks.summary,
}))
vi.mock('@/course-sync/dropbox-binding-config', () => ({
	dropboxSyncConfigFor: () => ({
		config: { source: { kind: 'shared-link' } },
		missingConfig: [],
	}),
}))
vi.mock('@/course-sync/types', () => ({
	getServerCourseSyncBinding: () => ({ bindingId: 'synthetic' }),
}))
vi.mock('@/course-sync/dropbox-mux-source', () => ({
	createBindingScopedMuxSourceResolver: (factory: typeof mocks.factory) => {
		mocks.factory = factory
		return {}
	},
	createDropboxMuxSourceResolver: mocks.mux,
	verifyDropboxMuxProxyToken: () => true,
}))
vi.mock('@/course-sync/control-plane', () => ({
	createCourseSyncControlPlane: () => ({}),
}))
vi.mock('@/course-sync/drizzle-persistence', () => ({
	drizzleCourseSyncPersistence: {},
}))
vi.mock('@/course-sync/mux-client', () => ({
	createCourseSyncMuxClient: () => ({}),
}))
vi.mock('google-auth-library', () => ({
	OAuth2Client: class {
		setCredentials = mocks.credentials
	},
}))
vi.mock('googleapis', () => ({
	google: {
		auth: {
			OAuth2: class {
				setCredentials = mocks.credentials
			},
		},
		youtube: () => ({
			channels: { list: async () => ({ data: { items: [] } }) },
			liveBroadcasts: { list: async () => ({ data: { items: [] } }) },
		}),
		youtubeAnalytics: () => ({
			reports: { query: async () => ({ data: { rows: [] } }) },
		}),
	},
}))
import '@/course-sync/runtime'
import { GET as assetGET } from '@/app/api/course-sync/dropbox-asset/route'
import { GET as dropboxGET } from '@/app/api/integrations/dropbox/route'
import {
	getChannelOverview,
	getVideoPerformance,
	getChannelTimeseries,
	getYouTubeTrafficSources,
	getVideoPerformanceWithTitles,
} from './youtube-data'
import {
	listYouTubeLiveBroadcasts,
	verifyYouTubeForceSslScope,
} from './youtube-live-broadcasts'

const key = Buffer.alloc(32, 7)

describe('readers use only the DB token (real store, mocked IO)', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.env.INTEGRATION_TOKEN_KEY = undefined
		mocks.env.DROPBOX_REFRESH_TOKEN = 'env-dropbox'
		mocks.env.YOUTUBE_ANALYTICS_REFRESH_TOKEN = 'env-youtube'
		vi.stubEnv('DROPBOX_REFRESH_TOKEN', 'raw-dropbox')
		mocks.mux.mockReturnValue({ resolve: async () => 'mux-result' })
		mocks.asset.mockResolvedValue({
			read: async () => ({
				stream: 'asset',
				bytes: 5,
				providerRevision: 'rev',
			}),
		})
		mocks.verify.mockResolvedValue({
			ok: true,
			sharedFolderBoundary: { verified: true },
		})
		mocks.summary.mockResolvedValue({
			manifest: {},
			course: {},
			structure: {},
		})
		mocks.fetch.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						scope: 'https://www.googleapis.com/auth/youtube.force-ssl',
					}),
				),
		)
		vi.stubGlobal('fetch', mocks.fetch)
	})
	afterEach(() => {
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
	})

	it(
		'runtime, proxy and Dropbox verification/manifest use the DB token',
		async () => {
			mocks.env.INTEGRATION_TOKEN_KEY = key.toString('base64')
			mocks.limit.mockResolvedValue([
				encryptIntegrationToken('dropbox', 'db-dropbox', key),
			])
			const resolver = mocks.factory({})
			expect(await resolver.resolve({})).toBe('mux-result')
			await resolver.resolve({})
			expect(mocks.mux).toHaveBeenCalledTimes(1) // Preserve one OAuth cache per binding.
			expect(mocks.mux).toHaveBeenCalledWith(
				expect.objectContaining({
					refreshToken: 'db-dropbox',
				}),
			)
			expect(
				(
					await assetGET(
						new Request('https://example.test/asset?binding=synthetic'),
					)
				).status,
			).toBe(200)
			expect(mocks.asset).toHaveBeenCalledWith(
				expect.objectContaining({
					refreshToken: 'db-dropbox',
				}),
			)
			await dropboxGET(
				new NextRequest(
					'https://example.test/api/integrations/dropbox?verify=1',
				),
			)
			expect(mocks.verify).toHaveBeenCalledWith(
				expect.objectContaining({
					refreshToken: 'db-dropbox',
				}),
			)
			await dropboxGET(
				new NextRequest(
					'https://example.test/api/integrations/dropbox?manifest=summary',
				),
			)
			expect(mocks.summary).toHaveBeenCalledWith(
				expect.objectContaining({
					refreshToken: 'db-dropbox',
				}),
			)
		},
	)
	it('ignores env tokens and reports Dropbox not connected in the runtime, proxy and Dropbox manifest', async () => {
		// env still holds env-dropbox / raw-dropbox; with no DB row it must be ignored.
		mocks.env.INTEGRATION_TOKEN_KEY = key.toString('base64')
		mocks.limit.mockResolvedValue([])
		await expect(mocks.factory({}).resolve({})).rejects.toMatchObject({
			code: 'DROPBOX_SYNC_NOT_CONFIGURED',
			message:
				'Dropbox sync is not configured: Dropbox not connected (no DB token row)',
		})
		expect(
			(
				await assetGET(
					new Request('https://example.test/asset?binding=synthetic'),
				)
			).status,
		).toBe(503)
		const response = await dropboxGET(
			new NextRequest(
				'https://example.test/api/integrations/dropbox?manifest=summary',
			),
		)
		expect(response.status).toBe(503)
		expect((await response.json()).missingConfig).toContain(
			'Dropbox not connected (no DB token row)',
		)
	})
	it(
		'every YouTube data auth path and live auth path uses the DB token',
		async () => {
			mocks.env.INTEGRATION_TOKEN_KEY = key.toString('base64')
			mocks.limit.mockResolvedValue([
				encryptIntegrationToken('youtube_analytics', 'db-youtube', key),
			])
			await getChannelOverview()
			await getVideoPerformance('7d')
			await getChannelTimeseries('7d')
			await getYouTubeTrafficSources('7d')
			await getVideoPerformanceWithTitles('7d')
			await listYouTubeLiveBroadcasts()
			expect(mocks.credentials).toHaveBeenCalledTimes(7)
			for (const [credentials] of mocks.credentials.mock.calls)
				expect(credentials).toEqual({
					refresh_token: 'db-youtube',
				})
			await verifyYouTubeForceSslScope()
			expect(mocks.fetch.mock.calls[0]![1].body.get('refresh_token')).toBe(
				'db-youtube',
			)
		},
	)
	it('preserves YouTube null/throw/empty-scope behavior with no DB token, ignoring env', async () => {
		expect(await getChannelOverview()).toBeNull()
		expect(await getVideoPerformance('7d')).toBeNull()
		expect(await getChannelTimeseries('7d')).toBeNull()
		expect(await getYouTubeTrafficSources('7d')).toBeNull()
		expect(await getVideoPerformanceWithTitles('7d')).toBeNull()
		await expect(listYouTubeLiveBroadcasts()).rejects.toThrow(
			'YouTube OAuth client ID, secret, and refresh token are required',
		)
		expect(await verifyYouTubeForceSslScope()).toEqual({
			grantedScopes: [],
			hasForceSsl: false,
		})
		expect(mocks.fetch).not.toHaveBeenCalled()
	})
})
