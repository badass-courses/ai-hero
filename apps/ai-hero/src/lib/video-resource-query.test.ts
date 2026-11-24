import { createMongoAbility } from '@casl/ability'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getServerAuthSession: vi.fn(),
	getVideoResource: vi.fn(),
}))

vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: { getVideoResource: mocks.getVideoResource },
	db: {},
}))
vi.mock('@/db/schema', () => ({}))
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/inngest/inngest.server', () => ({}))
vi.mock('@/lib/content-edit-guard', () => ({}))
vi.mock('@/lib/lesson-transcript-cache', () => ({}))
vi.mock('@/server/logger', () => ({}))

import { getVideoResource } from './video-resource-query'

const video = { id: 'video-1' }
const editorSession = { user: { id: 'editor-1' } }

describe('getVideoResource editor action', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getVideoResource.mockResolvedValue(video)
	})

	it('requires a session before reading the video', async () => {
		mocks.getServerAuthSession.mockResolvedValue({
			session: null,
			ability: createMongoAbility([{ action: 'create', subject: 'Content' }]),
		})

		await expect(getVideoResource(video.id)).rejects.toThrow('Unauthorized')
		expect(mocks.getVideoResource).not.toHaveBeenCalled()
	})

	it('refuses a session that can only read Content', async () => {
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { id: 'learner-1' } },
			ability: createMongoAbility([{ action: 'read', subject: 'Content' }]),
		})

		await expect(getVideoResource(video.id)).rejects.toThrow('Unauthorized')
		expect(mocks.getVideoResource).not.toHaveBeenCalled()
	})

	it.each(['create', 'update'])(
		'returns the record with %s Content ability',
		async (action) => {
			mocks.getServerAuthSession.mockResolvedValue({
				session: editorSession,
				ability: createMongoAbility([{ action, subject: 'Content' }]),
			})

			await expect(getVideoResource(video.id)).resolves.toBe(video)
			expect(mocks.getVideoResource).toHaveBeenCalledTimes(1)
			expect(mocks.getVideoResource).toHaveBeenCalledWith(video.id)
		},
	)
})
