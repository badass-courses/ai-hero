import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
	return {
		getServerAuthSession: vi.fn(),
		createPost: vi.fn(),
		createResource: vi.fn(),
		addPostToList: vi.fn(),
		getListWithSections: vi.fn(),
		executePostCreationSideEffects: vi.fn(),
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
	getListWithSections: mocks.getListWithSections,
}))

vi.mock('@/lib/posts-query', () => ({
	createPost: mocks.createPost,
	executePostCreationSideEffects: mocks.executePostCreationSideEffects,
}))

vi.mock('@/lib/resources/create-resources', () => ({
	createResource: mocks.createResource,
	executeResourceCreationSideEffects: mocks.executeResourceCreationSideEffects,
}))

import { createInList } from './list-contents'

describe('createInList', () => {
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

	it('creates a post and attaches it to the list atomically, running side-effects post-commit', async () => {
		const createdPost = { id: 'post_abc', title: 'My New Post', type: 'post' }
		mocks.createPost.mockResolvedValue(createdPost)
		mocks.addPostToList.mockResolvedValue({ position: 0 })

		await createInList('list_123', 'post', 'My New Post')

		expect(mocks.db.transaction).toHaveBeenCalledOnce()
		expect(mocks.createPost).toHaveBeenCalledWith(
			{
				title: 'My New Post',
				postType: 'article',
				createdById: 'user_123',
			},
			{ tx: { isTx: true }, deferSideEffects: true },
		)
		expect(mocks.addPostToList).toHaveBeenCalledWith({
			postId: 'post_abc',
			listId: 'list_123',
			metadata: { tier: 'standard' },
			tx: { isTx: true },
			revalidate: false,
		})

		// Post-commit side effects
		expect(mocks.executePostCreationSideEffects).toHaveBeenCalledWith(createdPost)
		expect(mocks.revalidateTag).toHaveBeenCalledWith('lists', 'max')
		expect(mocks.revalidateTag).toHaveBeenCalledWith('list_123', 'max')
	})

	it('creates a non-post type (e.g. section) and attaches it atomically', async () => {
		const createdSection = { id: 'section_xyz', title: 'Module 1', type: 'section' }
		mocks.createResource.mockResolvedValue(createdSection)
		mocks.addPostToList.mockResolvedValue({ position: 1 })

		await createInList('list_123', 'section', 'Module 1', 'Section description')

		expect(mocks.db.transaction).toHaveBeenCalledOnce()
		expect(mocks.createResource).toHaveBeenCalledWith(
			{
				type: 'section',
				title: 'Module 1',
				description: 'Section description',
			},
			{ tx: { isTx: true }, deferSideEffects: true },
		)
		expect(mocks.addPostToList).toHaveBeenCalledWith({
			postId: 'section_xyz',
			listId: 'list_123',
			metadata: { tier: 'standard' },
			tx: { isTx: true },
			revalidate: false,
		})

		// Post-commit side effects
		expect(mocks.executeResourceCreationSideEffects).toHaveBeenCalledWith(createdSection)
		expect(mocks.revalidateTag).toHaveBeenCalledWith('lists', 'max')
		expect(mocks.revalidateTag).toHaveBeenCalledWith('list_123', 'max')
	})

	it('fails and aborts without running side-effects if addPostToList throws inside transaction', async () => {
		const createdPost = { id: 'post_abc', title: 'My New Post', type: 'post' }
		mocks.createPost.mockResolvedValue(createdPost)
		mocks.addPostToList.mockRejectedValue(new Error('List not found'))

		await expect(createInList('list_nonexistent', 'post', 'My New Post')).rejects.toThrow(
			'List not found',
		)

		expect(mocks.db.transaction).toHaveBeenCalledOnce()
		// No side effects should have been executed because the transaction failed
		expect(mocks.executePostCreationSideEffects).not.toHaveBeenCalled()
		expect(mocks.revalidateTag).not.toHaveBeenCalled()
	})

	it('rejects unauthorized users before entering a transaction', async () => {
		mocks.getServerAuthSession.mockResolvedValue({
			session: null,
			ability: { can: () => false },
		})

		await expect(createInList('list_123', 'post')).rejects.toThrow('Unauthorized')

		expect(mocks.db.transaction).not.toHaveBeenCalled()
		expect(mocks.createPost).not.toHaveBeenCalled()
		expect(mocks.addPostToList).not.toHaveBeenCalled()
	})

	it('rejects unknown resource types before entering a transaction', async () => {
		await expect(createInList('list_123', 'invalid_unknown_type')).rejects.toThrow(
			'Cannot create an unknown resource type "invalid_unknown_type" in a list',
		)

		expect(mocks.db.transaction).not.toHaveBeenCalled()
		expect(mocks.createResource).not.toHaveBeenCalled()
	})
})
