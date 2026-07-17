import { describe, expect, it, vi } from 'vitest'
import {
	DEFAULT_DROPBOX_OAUTH_REDIRECT_URI,
	buildDropboxAuthorizationUrl,
	exchangeDropboxAuthorizationCode,
	getDropboxSyncConfig,
	readDropboxCourseManifestSummary,
	redeployAfterDropboxAuthorization,
	storeDropboxRefreshToken,
	verifyDropboxConnection,
} from './dropbox-course-sync'

const environment = {
	DROPBOX_APP_KEY: 'app-key',
	DROPBOX_APP_SECRET: 'app-secret',
	DROPBOX_SYNC_SHARED_FOLDER_ID: 'id:shared-folder',
	DROPBOX_SYNC_ALLOWED_ROOT: '/Courses/AI Hero',
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

describe('Dropbox course sync OAuth', () => {
	it('requires an approved Dropbox source boundary before starting OAuth', () => {
		const result = getDropboxSyncConfig({
			DROPBOX_APP_KEY: 'app-key',
			DROPBOX_APP_SECRET: 'app-secret',
		})

		expect(result.config).toBeNull()
		expect(result.missingConfig).toEqual([
			'DROPBOX_SYNC_SHARED_LINK or DROPBOX_SYNC_SHARED_FOLDER_ID plus DROPBOX_SYNC_ALLOWED_ROOT',
		])
	})

	it('requests offline access with only the required read scopes', () => {
		const { config } = getDropboxSyncConfig(environment)
		expect(config).not.toBeNull()
		const authorization = buildDropboxAuthorizationUrl(config!, 'state-123')
		const url = new URL(authorization.url)

		expect(url.searchParams.get('redirect_uri')).toBe(DEFAULT_DROPBOX_OAUTH_REDIRECT_URI)
		expect(url.searchParams.get('token_access_type')).toBe('offline')
		expect(url.searchParams.get('scope')).toBe(
			'account_info.read files.metadata.read files.content.read sharing.read',
		)
		expect(url.searchParams.get('state')).toBe('state-123')
	})

	it('rejects an authorization response missing a required scope', async () => {
		const { config } = getDropboxSyncConfig(environment)
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({ refresh_token: 'new-refresh-token', scope: 'account_info.read files.metadata.read' }),
		)

		await expect(
			exchangeDropboxAuthorizationCode({ code: 'code', config: config!, fetchImpl }),
		).rejects.toThrow('required read-only scopes')
	})

	it('verifies the token against the approved shared folder and root', async () => {
		const { config } = getDropboxSyncConfig(environment)
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					access_token: 'short-lived-token',
					scope: 'account_info.read files.metadata.read files.content.read sharing.read',
				}),
			)
			.mockResolvedValueOnce(jsonResponse({ account_id: 'dbid:account-id' }))
			.mockResolvedValueOnce(
				jsonResponse({ shared_folder_id: 'id:shared-folder', path_lower: '/courses' }),
			)
			.mockResolvedValueOnce(jsonResponse({ '.tag': 'folder', path_lower: '/courses/ai hero' }))

		const result = await verifyDropboxConnection({
			config,
			refreshToken: 'stored-refresh-token',
			fetchImpl,
		})

		expect(result).toMatchObject({
			ok: true,
			requiredScopesPresent: true,
			sharedFolderBoundary: { configured: true, verified: true },
		})
		expect(result.accountIdFingerprint).toHaveLength(12)
		expect(JSON.stringify(result)).not.toContain('dbid:account-id')
	})

	it('rejects a configured root outside the approved shared folder', async () => {
		const { config } = getDropboxSyncConfig(environment)
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ access_token: 'short-lived-token' }))
			.mockResolvedValueOnce(jsonResponse({ account_id: 'dbid:account-id' }))
			.mockResolvedValueOnce(jsonResponse({ path_lower: '/courses' }))
			.mockResolvedValueOnce(jsonResponse({ path_lower: '/outside' }))

		const result = await verifyDropboxConnection({
			config,
			refreshToken: 'stored-refresh-token',
			fetchImpl,
		})

		expect(result.ok).toBe(false)
		expect(result.sharedFolderBoundary.verified).toBe(false)
	})

	it('accepts a shared link and proves it contains the root course manifest', async () => {
		const { config } = getDropboxSyncConfig({
			DROPBOX_APP_KEY: 'app-key',
			DROPBOX_APP_SECRET: 'app-secret',
			DROPBOX_SYNC_SHARED_LINK: 'https://www.dropbox.com/scl/fo/example?rlkey=example',
		})
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ access_token: 'short-lived-token' }))
			.mockResolvedValueOnce(jsonResponse({ account_id: 'dbid:account-id' }))
			.mockResolvedValueOnce(jsonResponse({ '.tag': 'folder' }))
			.mockResolvedValueOnce(jsonResponse({ '.tag': 'file' }))

		const result = await verifyDropboxConnection({
			config,
			refreshToken: 'stored-refresh-token',
			fetchImpl,
		})

		expect(result).toMatchObject({
			ok: true,
			sharedFolderBoundary: { configured: true, verified: true },
		})
		expect(JSON.parse(fetchImpl.mock.calls[2][1].body)).toEqual({
			url: 'https://www.dropbox.com/scl/fo/example?rlkey=example',
		})
		expect(JSON.parse(fetchImpl.mock.calls[3][1].body)).toEqual({
			url: 'https://www.dropbox.com/scl/fo/example?rlkey=example',
			path: '/course.json',
		})
	})

	it('reads a revision-pinned manifest summary without exposing the shared link or source body', async () => {
		const sharedLink = 'https://www.dropbox.com/scl/fo/example?rlkey=secret-link-key'
		const { config } = getDropboxSyncConfig({
			DROPBOX_APP_KEY: 'app-key',
			DROPBOX_APP_SECRET: 'app-secret',
			DROPBOX_SYNC_SHARED_LINK: sharedLink,
		})
		const document = {
			schema: 'aihero.course-sync.v1',
			producer: {
				name: 'course-video-manager',
				revision: 'cvm-revision-42',
				exportedAt: '2026-07-16T23:00:00.000Z',
			},
			course: {
				sourceId: 'course-source-1',
				title: 'PRIVATE_COURSE_TITLE_SENTINEL',
				version: { sourceId: 'course-version-7' },
			},
			sections: [
				{
					lessons: [
						{
							title: 'PRIVATE_LESSON_TITLE_SENTINEL',
							body: { value: 'PRIVATE_LESSON_BODY_SENTINEL' },
							videos: [
								{
									media: {
										sourcePath: 'PRIVATE_ASSET_PATH_SENTINEL/video.mp4',
										sha256: 'a'.repeat(64),
									},
									transcript: { value: 'PRIVATE_TRANSCRIPT_SENTINEL' },
								},
							],
						},
					],
				},
			],
			assets: [
				{ sourcePath: 'lesson/video.mp4', sha256: 'a'.repeat(64) },
				{ sourcePath: 'lesson/transcript.md' },
			],
		}
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ access_token: 'short-lived-token' }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify(document), {
					status: 200,
					headers: {
						'Dropbox-API-Result': JSON.stringify({
							id: 'id:course-json',
							rev: '015manifestrev',
							content_hash: 'dropbox-content-hash',
							size: 1234,
							server_modified: '2026-07-16T23:00:01Z',
						}),
					},
				}),
			)

		const summary = await readDropboxCourseManifestSummary({
			config: config!,
			refreshToken: 'stored-refresh-token',
			fetchImpl,
		})

		expect(summary).toEqual({
			schema: 'aihero.course-sync.v1',
			producer: {
				name: 'course-video-manager',
				revision: 'cvm-revision-42',
				exportedAt: '2026-07-16T23:00:00.000Z',
			},
			course: {
				sourceId: 'course-source-1',
				versionSourceId: 'course-version-7',
			},
			structure: {
				sectionCount: 1,
				lessonCount: 1,
				videoCount: 1,
				declaredAssetCount: 2,
				declaredAssetsMissingSha256: 1,
				videoMediaCount: 1,
				videoMediaMissingSha256: 0,
			},
			manifest: {
				sourcePath: '/course.json',
				id: 'id:course-json',
				rev: '015manifestrev',
				contentHash: 'dropbox-content-hash',
				bytes: 1234,
				serverModified: '2026-07-16T23:00:01Z',
				sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
		})
		const serialized = JSON.stringify(summary)
		expect(serialized).not.toContain(sharedLink)
		expect(serialized).not.toContain('secret-link-key')
		expect(serialized).not.toContain('PRIVATE_')
		expect(serialized).not.toContain('short-lived-token')
		expect(serialized).not.toContain('stored-refresh-token')
		expect(serialized).not.toContain('app-secret')
		expect(fetchImpl.mock.calls[1][0]).toBe(
			'https://content.dropboxapi.com/2/sharing/get_shared_link_file',
		)
		expect(JSON.parse(fetchImpl.mock.calls[1][1].headers['Dropbox-API-Arg'])).toEqual({
			url: sharedLink,
			path: '/course.json',
		})
	})

	it('rejects malformed or oversized manifests before returning a summary', async () => {
		const { config } = getDropboxSyncConfig({
			DROPBOX_APP_KEY: 'app-key',
			DROPBOX_APP_SECRET: 'app-secret',
			DROPBOX_SYNC_SHARED_LINK: 'https://www.dropbox.com/scl/fo/example?rlkey=example',
		})
		const tokenResponse = jsonResponse({ access_token: 'short-lived-token' })
		const malformedResponse = new Response(
			JSON.stringify({
				schema: 'aihero.course-sync.v1',
				producer: {
					name: 'course-video-manager',
					exportedAt: '2026-07-16T23:00:00.000Z',
				},
				course: { sourceId: 'course-1', version: { sourceId: 'version-1' } },
				sections: {},
			}),
			{
				headers: {
					'Dropbox-API-Result': JSON.stringify({ rev: 'rev-1', size: 200 }),
				},
			},
		)
		const malformedFetch = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse)
			.mockResolvedValueOnce(malformedResponse)

		await expect(
			readDropboxCourseManifestSummary({
				config: config!,
				refreshToken: 'stored-refresh-token',
				fetchImpl: malformedFetch,
			}),
		).rejects.toThrow('sections were missing or invalid')

		const invalidVideoFetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ access_token: 'short-lived-token' }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						schema: 'aihero.course-sync.v1',
						producer: {
							name: 'course-video-manager',
							exportedAt: '2026-07-16T23:00:00.000Z',
						},
						course: { sourceId: 'course-1', version: { sourceId: 'version-1' } },
						sections: [{ lessons: [{ videos: ['invalid'] }] }],
					}),
					{
						headers: {
							'Dropbox-API-Result': JSON.stringify({ rev: 'rev-2', size: 400 }),
						},
					},
				),
			)

		await expect(
			readDropboxCourseManifestSummary({
				config: config!,
				refreshToken: 'stored-refresh-token',
				fetchImpl: invalidVideoFetch,
			}),
		).rejects.toThrow('video was invalid')

		const oversizedFetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ access_token: 'short-lived-token' }))
			.mockResolvedValueOnce(
				new Response('{}', {
					headers: {
						'Dropbox-API-Result': JSON.stringify({
							rev: 'rev-2',
							size: 5 * 1024 * 1024 + 1,
						}),
					},
				}),
			)

		await expect(
			readDropboxCourseManifestSummary({
				config: config!,
				refreshToken: 'stored-refresh-token',
				fetchImpl: oversizedFetch,
			}),
		).rejects.toThrow('exceeds the maximum allowed size')
	})

	it('stores the callback-issued refresh token as encrypted Vercel configuration', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 'env_1' }))
		const result = await storeDropboxRefreshToken({
			refreshToken: 'callback-refresh-token',
			environment: {
				VERCEL_API_TOKEN: 'vercel-token',
				VERCEL_AI_HERO_PROJECT_ID: 'prj_aihero',
				VERCEL_TEAM_ID: 'team_aihero',
			},
			fetchImpl,
		})

		expect(result).toEqual({ ok: true, missingConfig: [], statuses: [200, 200, 200] })
		expect(fetchImpl).toHaveBeenCalledTimes(3)
		for (const [, options] of fetchImpl.mock.calls) {
			expect(JSON.parse(options.body)).toMatchObject({
				key: 'DROPBOX_REFRESH_TOKEN',
				type: 'encrypted',
			})
		}
	})

	it('triggers a production deployment after storing a refresh token', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 'dpl_1' }))
		const result = await redeployAfterDropboxAuthorization({
			environment: { VERCEL_API_TOKEN: 'vercel-token', VERCEL_TEAM_ID: 'team_aihero' },
			fetchImpl,
		})

		expect(result).toEqual({ ok: true, missingConfig: [], status: 200 })
		const [url, options] = fetchImpl.mock.calls[0]
		expect(url).toContain('/v13/deployments?teamId=team_aihero')
		expect(JSON.parse(options.body)).toMatchObject({
			name: 'ai-hero',
			target: 'production',
			gitSource: { repo: 'ai-hero', ref: 'main', org: 'badass-courses' },
		})
	})
})
