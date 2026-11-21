import { createMongoAbility, type AnyMongoAbility } from '@casl/ability'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// addPostToList and removePostFromList must check the list record, not just
// the type: contributor rules are createdById-conditioned (sec-034).

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	findFirst: vi.fn(),
	insert: vi.fn(),
	del: vi.fn(),
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: {},
	db: {
		query: { contentResource: { findFirst: mocks.findFirst } },
		insert: mocks.insert,
		delete: mocks.del,
		transaction: vi.fn(),
	},
}))
vi.mock('@/server/auth', () => ({ getServerAuthSession: mocks.session }))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('./posts-query', () => ({ updatePost: vi.fn() }))
vi.mock('./typesense-query', () => ({
	deletePostInTypeSense: vi.fn(),
	upsertPostToTypeSense: vi.fn(),
}))
vi.mock('next/cache', () => ({
	revalidatePath: vi.fn(),
	revalidateTag: vi.fn(),
	unstable_cache: (fn: unknown) => fn,
}))

import { addPostToList, removePostFromList } from './lists-query'

const contributor = createMongoAbility([
	{ action: 'manage', subject: 'Content', conditions: { createdById: 'u1' } },
])
const as = (ability: AnyMongoAbility) =>
	mocks.session.mockResolvedValue({ session: { user: { id: 'u1' } }, ability })

const othersList = {
	id: 'list_1',
	type: 'list',
	createdById: 'someone-else',
	resources: [],
}
const tx = {
	query: { contentResource: { findFirst: mocks.findFirst } },
	insert: mocks.insert,
} as any

beforeEach(() => {
	vi.clearAllMocks()
	mocks.findFirst.mockResolvedValue(othersList)
})

describe('list membership writes', () => {
	it("refuses a contributor adding to someone else's list", async () => {
		as(contributor)
		await expect(
			addPostToList({
				postId: 'post_1',
				listId: 'list_1',
				metadata: { tier: 'premium' },
				tx,
				revalidate: false,
			}),
		).rejects.toThrow('Unauthorized')
		expect(mocks.insert).not.toHaveBeenCalled()
	})

	it("refuses a contributor removing from someone else's list", async () => {
		as(contributor)
		await expect(
			removePostFromList({ postId: 'post_1', listId: 'list_1' }),
		).rejects.toThrow('Unauthorized')
		expect(mocks.del).not.toHaveBeenCalled()
	})
})
