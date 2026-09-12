import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
	return {
		getServerAuthSession: vi.fn(),
		createPost: vi.fn(),
		writeNewLessonToDatabase: vi.fn(),
		createResource: vi.fn(),
		addPostToList: vi.fn(),
		getWorkshop: vi.fn(),
		executePostCreationSideEffects: vi.fn(),
		executeLessonCreationSideEffects: vi.fn(),
		executeResourceCreationSideEffects: vi.fn(),
		revalidateTag: vi.fn(),
		db: {
			transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => {
				const fakeTx = { isTx: true }
				return await cb(fakeTx)
			}),
		},
	}
})

vi.mock('next/cache', () => ({
	revalidateTag: mocks.revalidateTag,
}))

vi.mock('@/db', () => ({
	db: mocks.db,
}))

vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))

vi.mock('@/lib/lists-query', () => ({
	addPostToList: mocks.addPostToList,
}))

vi.mock('@/lib/posts-query', () => ({
	createPost: mocks.createPost,
	executePostCreationSideEffects: mocks.executePostCreationSideEffects,
}))

vi.mock('@/lib/lessons-query', () => ({
	writeNewLessonToDatabase: mocks.writeNewLessonToDatabase,
	executeLessonCreationSideEffects: mocks.executeLessonCreationSideEffects,
}))

vi.mock('@/lib/resources/create-resources', () => ({
	createResource: mocks.createResource,
	executeResourceCreationSideEffects: mocks.executeResourceCreationSideEffects,
}))

vi.mock('@/lib/workshops-query', () => ({
	getWorkshop: mocks.getWorkshop,
}))

import { createWorkshopChild } from './workshop-contents'

describe('createWorkshopChild', () => {
	const user = { id: 'user_123', email: 'test@example.com' }
	const mockAbility = {
		can: vi.fn((action: string, subject: string) => {
			if (action === 'create' && subject === 'Content') return true
			if (action === 'update' && subject === 'Content') return true
			return false
		}),
	}

	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user },
			ability: mockAbility,
		})
	})

	it('creates a lesson and attaches it to the workshop atomically', async () => {
		const createdLesson = { id: 'lesson_123', title: 'Untitled lesson', type: 'lesson' }
		mocks.writeNewLessonToDatabase.mockResolvedValue(createdLesson)
		mocks.addPostToList.mockResolvedValue({
			position: 0,
			resource: {
				id: 'lesson_123',
				type: 'lesson',
				fields: { title: 'Untitled lesson', state: 'draft' },
			},
		})

		const item = await createWorkshopChild('workshop_1', 'lesson')

		expect(mocks.db.transaction).toHaveBeenCalledOnce()
		expect(mocks.writeNewLessonToDatabase).toHaveBeenCalledWith(
			{
				title: 'Untitled lesson',
				lessonType: 'lesson',
				createdById: 'user_123',
			},
			{ tx: { isTx: true }, deferSideEffects: true },
		)
		expect(mocks.addPostToList).toHaveBeenCalledWith({
			postId: 'lesson_123',
			listId: 'workshop_1',
			metadata: { tier: 'standard' },
			tx: { isTx: true },
			revalidate: false,
		})

		expect(mocks.executeLessonCreationSideEffects).toHaveBeenCalledWith(createdLesson)
		expect(mocks.revalidateTag).toHaveBeenCalledWith('lesson', 'max')
		expect(mocks.revalidateTag).toHaveBeenCalledWith('workshop-navigation', 'max')
		expect(mocks.revalidateTag).toHaveBeenCalledWith('lists', 'max')
		expect(mocks.revalidateTag).toHaveBeenCalledWith('workshop_1', 'max')
		expect(item.id).toBe('lesson_123')
	})

	it('creates a section and attaches it to the workshop atomically', async () => {
		const createdSection = { id: 'section_456', title: 'Untitled section', type: 'section' }
		mocks.createResource.mockResolvedValue(createdSection)
		mocks.addPostToList.mockResolvedValue({
			position: 1,
			resource: {
				id: 'section_456',
				type: 'section',
				fields: { title: 'Untitled section', state: 'draft' },
			},
		})

		const item = await createWorkshopChild('workshop_1', 'section')

		expect(mocks.db.transaction).toHaveBeenCalledOnce()
		expect(mocks.createResource).toHaveBeenCalledWith(
			{
				type: 'section',
				title: 'Untitled section',
			},
			{ tx: { isTx: true }, deferSideEffects: true },
		)
		expect(mocks.addPostToList).toHaveBeenCalledWith({
			postId: 'section_456',
			listId: 'workshop_1',
			metadata: { tier: 'standard' },
			tx: { isTx: true },
			revalidate: false,
		})

		expect(mocks.executeResourceCreationSideEffects).toHaveBeenCalledWith(createdSection)
		expect(mocks.revalidateTag).toHaveBeenCalledWith('lists', 'max')
		expect(mocks.revalidateTag).toHaveBeenCalledWith('workshop_1', 'max')
		expect(item.id).toBe('section_456')
	})

	it('creates a post and attaches it to the workshop atomically', async () => {
		const createdPost = { id: 'post_789', title: 'Untitled post', type: 'post' }
		mocks.createPost.mockResolvedValue(createdPost)
		mocks.addPostToList.mockResolvedValue({
			position: 2,
			resource: {
				id: 'post_789',
				type: 'post',
				fields: { title: 'Untitled post', state: 'draft' },
			},
		})

		const item = await createWorkshopChild('workshop_1', 'post')

		expect(mocks.db.transaction).toHaveBeenCalledOnce()
		expect(mocks.createPost).toHaveBeenCalledWith(
			{
				title: 'Untitled post',
				postType: 'article',
				createdById: 'user_123',
			},
			{ tx: { isTx: true }, deferSideEffects: true },
		)
		expect(mocks.addPostToList).toHaveBeenCalledWith({
			postId: 'post_789',
			listId: 'workshop_1',
			metadata: { tier: 'standard' },
			tx: { isTx: true },
			revalidate: false,
		})

		expect(mocks.executePostCreationSideEffects).toHaveBeenCalledWith(createdPost)
		expect(mocks.revalidateTag).toHaveBeenCalledWith('lists', 'max')
		expect(mocks.revalidateTag).toHaveBeenCalledWith('workshop_1', 'max')
		expect(item.id).toBe('post_789')
	})

	it('rolls back and skips side-effects if attach throws an error', async () => {
		const createdLesson = { id: 'lesson_123', title: 'Untitled lesson', type: 'lesson' }
		mocks.writeNewLessonToDatabase.mockResolvedValue(createdLesson)
		mocks.addPostToList.mockRejectedValue(new Error('Database connection failed'))

		await expect(createWorkshopChild('workshop_1', 'lesson')).rejects.toThrow(
			'Database connection failed',
		)

		expect(mocks.db.transaction).toHaveBeenCalledOnce()
		expect(mocks.executeLessonCreationSideEffects).not.toHaveBeenCalled()
		expect(mocks.revalidateTag).not.toHaveBeenCalled()
	})

	it('rejects unauthorized users before entering a transaction', async () => {
		mocks.getServerAuthSession.mockResolvedValue({
			session: null,
			ability: { can: () => false },
		})

		await expect(createWorkshopChild('workshop_1', 'lesson')).rejects.toThrow('Unauthorized')

		expect(mocks.db.transaction).not.toHaveBeenCalled()
		expect(mocks.writeNewLessonToDatabase).not.toHaveBeenCalled()
	})

	it('rejects unsupported child types without opening a transaction', async () => {
		await expect(createWorkshopChild('workshop_1', 'unsupported_type')).rejects.toThrow(
			'Cannot quick-create a "unsupported_type" in a workshop',
		)

		expect(mocks.db.transaction).not.toHaveBeenCalled()
	})
})
