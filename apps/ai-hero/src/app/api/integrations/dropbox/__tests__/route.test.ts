import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	buildDropboxAuthorizationUrl: vi.fn(),
	exchangeDropboxAuthorizationCode: vi.fn(),
	getDropboxSyncConfig: vi.fn(),
	readDropboxCourseManifestSummary: vi.fn(),
	redeployAfterDropboxAuthorization: vi.fn(),
	storeDropboxRefreshToken: vi.fn(),
	verifyDropboxConnection: vi.fn(),
	getUserAbilityForRequest: vi.fn(),
	getServerAuthSession: vi.fn(),
	log: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		flush: vi.fn(),
	},
}))

vi.mock('@/lib/dropbox-course-sync', () => ({
	buildDropboxAuthorizationUrl: mocks.buildDropboxAuthorizationUrl,
	exchangeDropboxAuthorizationCode: mocks.exchangeDropboxAuthorizationCode,
	getDropboxSyncConfig: mocks.getDropboxSyncConfig,
	readDropboxCourseManifestSummary: mocks.readDropboxCourseManifestSummary,
	redeployAfterDropboxAuthorization: mocks.redeployAfterDropboxAuthorization,
	storeDropboxRefreshToken: mocks.storeDropboxRefreshToken,
	verifyDropboxConnection: mocks.verifyDropboxConnection,
}))

vi.mock('@/server/ability-for-request', () => ({
	getUserAbilityForRequest: mocks.getUserAbilityForRequest,
}))

vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))

vi.mock('@/server/logger', () => ({
	log: mocks.log,
}))

vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))

import { GET } from '../route'

const sharedLinkConfig = {
	appKey: 'app-key',
	appSecret: 'app-secret',
	redirectUri: 'https://www.aihero.dev/api/integrations/dropbox',
	source: {
		kind: 'shared-link' as const,
		sharedLink: 'https://www.dropbox.com/scl/fo/example?rlkey=private',
	},
}

const summary = {
	contract: {
		name: 'course-video-manager.course-json' as const,
	},
	contractSchemaVersion: 3 as const,
	producer: { name: 'course-video-manager' as const },
	course: {
		sourceId: 'course-source-id',
	},
	courseVersionId: '8471116f-6201-406f-9a40-3672e457fd50',
	archiveTTL: '90d' as const,
	structure: {
		sectionCount: 3,
		lessonCount: 29,
		videoCount: 34,
		videosWithByteSha256: 34,
	},
	manifest: {
		sourcePath: '/course.json' as const,
		id: 'id:manifest',
		rev: 'manifest-revision',
		contentHash: 'dropbox-content-hash',
		bytes: 1234,
		serverModified: '2026-07-16T23:00:01Z',
		sha256: 'a'.repeat(64),
	},
}

function ability(allowed: boolean) {
	return {
		can: vi.fn((action: string, subject: string) => {
			return allowed && action === 'manage' && subject === 'all'
		}),
	}
}

function request() {
	return new NextRequest(
		'http://localhost:3000/api/integrations/dropbox?manifest=summary',
	)
}

describe('Dropbox course manifest summary route', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		process.env.DROPBOX_REFRESH_TOKEN = 'stored-refresh-token'
		mocks.getDropboxSyncConfig.mockReturnValue({
			config: sharedLinkConfig,
			missingConfig: [],
		})
		mocks.getUserAbilityForRequest.mockResolvedValue({
			user: null,
			ability: ability(false),
		})
		mocks.getServerAuthSession.mockResolvedValue({
			session: null,
			ability: ability(false),
		})
		mocks.readDropboxCourseManifestSummary.mockResolvedValue(summary)
	})

	afterEach(() => {
		delete process.env.DROPBOX_REFRESH_TOKEN
	})

	it('rejects anonymous and non-admin callers before Dropbox is read', async () => {
		const anonymousResponse = await GET(request())
		expect(anonymousResponse.status).toBe(401)
		expect(anonymousResponse.headers.get('Cache-Control')).toBe('no-store')
		expect(mocks.readDropboxCourseManifestSummary).not.toHaveBeenCalled()

		mocks.getUserAbilityForRequest.mockResolvedValue({
			user: { id: 'user-non-admin' },
			ability: ability(false),
		})
		const nonAdminResponse = await GET(request())
		expect(nonAdminResponse.status).toBe(401)
		expect(mocks.readDropboxCourseManifestSummary).not.toHaveBeenCalled()
	})

	it('returns the exact redacted summary to an admin device token', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue({
			user: { id: 'user-admin' },
			ability: ability(true),
		})

		const response = await GET(request())
		expect(response.status).toBe(200)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(await response.json()).toEqual({ ok: true, summary })
		expect(mocks.readDropboxCourseManifestSummary).toHaveBeenCalledWith({
			config: sharedLinkConfig,
			refreshToken: 'stored-refresh-token',
		})
		expect(mocks.log.info).toHaveBeenCalledWith(
			'dropbox-course-sync.manifest-summary.completed',
			expect.objectContaining({
				contractSchemaVersion: 3,
				courseVersionId: '8471116f-6201-406f-9a40-3672e457fd50',
				archiveTTL: '90d',
				sectionCount: 3,
				lessonCount: 29,
				videoCount: 34,
				videosWithByteSha256: 34,
			}),
		)
	})

	it('accepts an admin browser session when no device token is present', async () => {
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { id: 'user-admin' } },
			ability: ability(true),
		})

		const response = await GET(request())
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ ok: true, summary })
	})

	it('rejects unsupported folder configuration before Dropbox is read', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue({
			user: { id: 'user-admin' },
			ability: ability(true),
		})
		mocks.getDropboxSyncConfig.mockReturnValue({
			config: {
				...sharedLinkConfig,
				source: {
					kind: 'folder',
					sharedFolderId: 'id:folder',
					allowedRoot: '/course',
				},
			},
			missingConfig: [],
		})

		const response = await GET(request())
		expect(response.status).toBe(503)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(await response.json()).toMatchObject({
			ok: false,
			missingConfig: ['DROPBOX_SYNC_SHARED_LINK'],
		})
		expect(mocks.readDropboxCourseManifestSummary).not.toHaveBeenCalled()
	})

	it('does not expose Dropbox errors or credentials', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue({
			user: { id: 'user-admin' },
			ability: ability(true),
		})
		mocks.readDropboxCourseManifestSummary.mockRejectedValue(
			new Error('private-link stored-refresh-token app-secret'),
		)

		const response = await GET(request())
		const body = await response.json()
		expect(response.status).toBe(500)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(body).toEqual({
			ok: false,
			error: 'Dropbox course manifest summary failed.',
		})
		expect(JSON.stringify(body)).not.toContain('private-link')
		expect(JSON.stringify(body)).not.toContain('stored-refresh-token')
		expect(JSON.stringify(body)).not.toContain('app-secret')
	})
})

describe('Dropbox OAuth callback DB storage notice', () => {
	function callback() {
		return new NextRequest(
			'http://localhost:3000/api/integrations/dropbox?code=synthetic-code&state=synthetic-state',
			{ headers: { cookie: 'dropbox_course_sync_state=synthetic-state' } },
		)
	}

	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getDropboxSyncConfig.mockReturnValue({
			config: sharedLinkConfig,
			missingConfig: [],
		})
		mocks.exchangeDropboxAuthorizationCode.mockResolvedValue({
			refreshToken: 'fresh-dropbox',
			grantedScopes: [],
		})
		mocks.verifyDropboxConnection.mockResolvedValue({
			ok: true,
			requiredScopesPresent: true,
			sharedFolderBoundary: { configured: true, verified: true },
		})
		mocks.redeployAfterDropboxAuthorization.mockResolvedValue({
			ok: true,
			missingConfig: [],
			status: 200,
		})
	})

	it.each([
		[undefined, null],
		[{ ok: false, staleRow: false }, 'DB token store failed; using env.'],
		[
			{ ok: false, staleRow: true },
			'DB token store failed and a stale DB row may remain; delete it before the next deploy.',
		],
	])('renders the success page for DB result %j', async (dbStorage, notice) => {
		mocks.storeDropboxRefreshToken.mockResolvedValue({
			ok: true,
			missingConfig: [],
			statuses: [200, 200, 200],
			...(dbStorage ? { dbStorage } : {}),
		})
		const response = await GET(callback())
		expect(response.status).toBe(200)
		const html = await response.text()
		expect(html).toContain('<h1>Dropbox authorized</h1>')
		expect(html).not.toContain('fresh-dropbox')
		if (notice) expect(html).toContain(`<p>${notice}</p>`)
		else expect(html).not.toContain('DB token store failed')
	})

	it('adds the stale-row notice when Vercel storage also failed', async () => {
		mocks.storeDropboxRefreshToken.mockResolvedValue({
			ok: false,
			missingConfig: [],
			statuses: [500, 500, 500],
			dbStorage: { ok: false, staleRow: true },
		})
		const html = await (await GET(callback())).text()
		expect(html).toContain('Dropbox authorization was not stored')
		expect(html).toContain('a stale DB row may remain')
		expect(mocks.redeployAfterDropboxAuthorization).not.toHaveBeenCalled()
	})
})
