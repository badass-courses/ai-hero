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
		schemaVersion: 2 as const,
	},
	producer: { name: 'course-video-manager' as const },
	course: {
		sourceId: 'course-source-id',
		sourceVersionId: null,
	},
	structure: {
		sectionCount: 1,
		lessonCount: 2,
		videoCount: 3,
		videoExportHashCount: 3,
	},
	bindingReadiness: {
		sourceVersionPinned: false as const,
		videoDropboxRevisionsPinned: false as const,
		videoByteSha256Complete: false as const,
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
