import { describe, expect, it, vi } from 'vitest'
import {
	DEFAULT_DROPBOX_OAUTH_REDIRECT_URI,
	buildDropboxAuthorizationUrl,
	exchangeDropboxAuthorizationCode,
	getDropboxSyncConfig,
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
	it('requires a shared folder and allowed root before starting OAuth', () => {
		const result = getDropboxSyncConfig({
			DROPBOX_APP_KEY: 'app-key',
			DROPBOX_APP_SECRET: 'app-secret',
		})

		expect(result.config).toBeNull()
		expect(result.missingConfig).toEqual([
			'DROPBOX_SYNC_SHARED_FOLDER_ID',
			'DROPBOX_SYNC_ALLOWED_ROOT',
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
