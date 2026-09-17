import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	contentResourceFindFirst: vi.fn(),
	getServerAuthSession: vi.fn(),
	log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock('@/db', () => ({
	db: {
		query: {
			contentResource: { findFirst: mocks.contentResourceFindFirst },
		},
	},
}))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))

import { GET } from '../restricted-videos/[videoResourceId]/route'

const ORG_ID = 'org_team_alpha'
const OTHER_ORG_ID = 'org_someone_else'
const PLAYBACK_ID = 'playback_test_only'

function request(videoResourceId: string) {
	return {
		req: new NextRequest(
			`http://localhost:3000/api/restricted-videos/${videoResourceId}`,
		),
		props: { params: Promise.resolve({ videoResourceId }) },
	}
}

function call(videoResourceId = 'video_welcome') {
	const { req, props } = request(videoResourceId)
	return GET(req, props)
}

function restrictedResource(fields: Record<string, unknown> = {}) {
	return {
		id: 'video_welcome',
		type: 'videoResource',
		fields: {
			state: 'ready',
			title: 'Welcome, team',
			duration: 214,
			muxPlaybackId: PLAYBACK_ID,
			restrictedToOrganizationId: ORG_ID,
			...fields,
		},
	}
}

function session({
	organizationIds,
	canManageAll = false,
}: {
	organizationIds: string[]
	canManageAll?: boolean
}) {
	return {
		session: {
			user: {
				id: 'user_1',
				organizationRoles: organizationIds.map((organizationId, index) => ({
					id: `role_${index}`,
					organizationId,
					name: 'learner',
				})),
			},
		},
		ability: {
			can: (action: string, subject: string) =>
				canManageAll && action === 'manage' && subject === 'all',
		},
	}
}

const anonymousSession = {
	session: null,
	ability: { can: () => false },
}

describe('GET /api/restricted-videos/[videoResourceId]', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('serves playback details to a member of the owning organization', async () => {
		mocks.getServerAuthSession.mockResolvedValue(
			session({ organizationIds: [OTHER_ORG_ID, ORG_ID] }),
		)
		mocks.contentResourceFindFirst.mockResolvedValue(restrictedResource())

		const response = await call()
		const body = await response.json()

		expect(response.status).toBe(200)
		expect(body).toEqual({
			playbackId: PLAYBACK_ID,
			title: 'Welcome, team',
			duration: 214,
		})
		expect(response.headers.get('Cache-Control')).toBe('private, no-store')
	})

	it('serves an admin who is not in the organization', async () => {
		mocks.getServerAuthSession.mockResolvedValue(
			session({ organizationIds: [], canManageAll: true }),
		)
		mocks.contentResourceFindFirst.mockResolvedValue(restrictedResource())

		const response = await call()

		expect(response.status).toBe(200)
		expect((await response.json()).playbackId).toBe(PLAYBACK_ID)
	})

	it('forbids a signed-in user from another organization', async () => {
		mocks.getServerAuthSession.mockResolvedValue(
			session({ organizationIds: [OTHER_ORG_ID] }),
		)
		mocks.contentResourceFindFirst.mockResolvedValue(restrictedResource())

		const response = await call()
		const body = await response.json()

		expect(response.status).toBe(403)
		expect(body).toEqual({ error: 'Forbidden' })
		expect(JSON.stringify(body)).not.toContain(PLAYBACK_ID)
	})

	it('forbids an anonymous viewer', async () => {
		mocks.getServerAuthSession.mockResolvedValue(anonymousSession)
		mocks.contentResourceFindFirst.mockResolvedValue(restrictedResource())

		const response = await call()
		const body = await response.json()

		expect(response.status).toBe(403)
		expect(JSON.stringify(body)).not.toContain(PLAYBACK_ID)
	})

	it('refuses a videoResource that carries no organization restriction', async () => {
		mocks.getServerAuthSession.mockResolvedValue(
			session({ organizationIds: [ORG_ID], canManageAll: true }),
		)
		mocks.contentResourceFindFirst.mockResolvedValue(
			restrictedResource({ restrictedToOrganizationId: undefined }),
		)

		const response = await call()
		const body = await response.json()

		expect(response.status).toBe(403)
		expect(JSON.stringify(body)).not.toContain(PLAYBACK_ID)
	})

	it('404s when the resource does not exist', async () => {
		mocks.getServerAuthSession.mockResolvedValue(
			session({ organizationIds: [ORG_ID] }),
		)
		mocks.contentResourceFindFirst.mockResolvedValue(undefined)

		const response = await call('video_missing')

		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ error: 'Not found' })
	})

	it('404s when the resource is not a videoResource', async () => {
		mocks.getServerAuthSession.mockResolvedValue(
			session({ organizationIds: [ORG_ID] }),
		)
		mocks.contentResourceFindFirst.mockResolvedValue({
			...restrictedResource(),
			type: 'post',
		})

		const response = await call()

		expect(response.status).toBe(404)
	})

	it('forbids a member when the video has no playback id yet', async () => {
		mocks.getServerAuthSession.mockResolvedValue(
			session({ organizationIds: [ORG_ID] }),
		)
		mocks.contentResourceFindFirst.mockResolvedValue(
			restrictedResource({ muxPlaybackId: null, state: 'processing' }),
		)

		const response = await call()

		expect(response.status).toBe(403)
	})

	it('500s without leaking the playback id when the lookup throws', async () => {
		mocks.getServerAuthSession.mockResolvedValue(
			session({ organizationIds: [ORG_ID] }),
		)
		mocks.contentResourceFindFirst.mockRejectedValue(
			new Error(`boom ${PLAYBACK_ID}`),
		)

		const response = await call()
		const body = await response.json()

		expect(response.status).toBe(500)
		expect(JSON.stringify(body)).not.toContain(PLAYBACK_ID)
	})
})
