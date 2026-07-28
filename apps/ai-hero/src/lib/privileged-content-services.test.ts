import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getAllLessons: vi.fn(),
	getAllPosts: vi.fn(),
	getAllPostsForUser: vi.fn(),
	log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock('next/cache', () => ({
	revalidatePath: vi.fn(),
	revalidateTag: vi.fn(),
}))
vi.mock('@/db', () => ({ courseBuilderAdapter: {}, db: {} }))
vi.mock('@/inngest/events/resource-management', () => ({
	RESOURCE_CREATED_EVENT: 'resource/created',
}))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { send: vi.fn() },
}))
vi.mock('@/lib/lessons-query', () => ({
	deleteLessonFromDatabase: vi.fn(),
	getAllLessons: mocks.getAllLessons,
	writeLessonUpdateToDatabase: vi.fn(),
	writeNewLessonToDatabase: vi.fn(),
}))
vi.mock('@/lib/posts-query', () => ({
	deletePostFromDatabase: vi.fn(),
	getAllPosts: mocks.getAllPosts,
	getAllPostsForUser: mocks.getAllPostsForUser,
	writeNewPostToDatabase: vi.fn(),
	writePostUpdateToDatabase: vi.fn(),
}))
vi.mock('@/lib/typesense-query', () => ({
	deletePostInTypeSense: vi.fn(),
	upsertPostToTypeSense: vi.fn(),
}))
vi.mock('@/lib/workshops-query', () => ({ getWorkshopsForLesson: vi.fn() }))
vi.mock('@/server/logger', () => ({ log: mocks.log }))

import { getLessons } from '@/lib/lessons/lessons.service'
import { getPosts } from '@/lib/posts/posts.service'
import { buildPersonalAccessTokenAbility } from '@/server/pat-scopes'

describe('privileged content service lists', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getAllLessons.mockResolvedValue([{ id: 'lesson_draft' }])
		mocks.getAllPosts.mockResolvedValue([{ id: 'post_draft' }])
		mocks.getAllPostsForUser.mockResolvedValue([{ id: 'post_owned' }])
	})

	it('returns every post instead of owner-filtering a PAT by attribution user', async () => {
		const ability = buildPersonalAccessTokenAbility(['content:read'])

		await expect(
			getPosts({ userId: 'attribution-user', ability }),
		).resolves.toEqual([{ id: 'post_draft' }])
		expect(mocks.getAllPosts).toHaveBeenCalledOnce()
		expect(mocks.getAllPostsForUser).not.toHaveBeenCalled()
	})

	it('allows a content PAT through the all-lessons read gate', async () => {
		const ability = buildPersonalAccessTokenAbility(['content:read'])

		await expect(
			getLessons({ userId: 'attribution-user', ability }),
		).resolves.toEqual([{ id: 'lesson_draft' }])
		expect(mocks.getAllLessons).toHaveBeenCalledOnce()
	})
})
