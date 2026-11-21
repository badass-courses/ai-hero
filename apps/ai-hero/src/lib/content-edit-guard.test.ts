import { createMongoAbility } from '@casl/ability'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	findMany: vi.fn(),
	findFirst: vi.fn(),
	transaction: vi.fn(),
	update: vi.fn(),
	insert: vi.fn(),
}))
vi.mock('@/server/auth', () => ({ getServerAuthSession: mocks.session }))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))
vi.mock('next/cache', () => ({
	revalidatePath: vi.fn(),
	revalidateTag: vi.fn(),
	unstable_cache: (fn: unknown) => fn,
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: {},
	db: {
		query: {
			contentResource: { findMany: mocks.findMany, findFirst: mocks.findFirst },
			contentResourceResource: { findFirst: vi.fn() },
		},
		transaction: mocks.transaction,
		update: mocks.update,
		insert: mocks.insert,
	},
}))

import { requireContentUpdate } from './content-edit-guard'
import {
	addResourceToTutorial,
	batchUpdateResourcePositions,
	updateResourcePosition,
	updateResourcePositions,
} from './tutorials-query'

const contributor = (id: string) =>
	createMongoAbility([
		{ action: 'manage', subject: 'Content', conditions: { createdById: id } },
	])
const as = (ability: ReturnType<typeof createMongoAbility> | null) =>
	mocks.session.mockResolvedValue(
		ability
			? { session: { user: { id: 'u1' } }, ability }
			: { session: null, ability: createMongoAbility([]) },
	)

const theirs = { id: 'workshop-theirs', type: 'workshop', createdById: 'other' }
const mine = { id: 'workshop-mine', type: 'workshop', createdById: 'u1' }

const unlock = [
	{
		resourceId: 'lesson-1',
		resourceOfId: theirs.id,
		currentParentResourceId: theirs.id,
		position: 0,
		metadata: { tier: 'free' },
	},
]

beforeEach(() => {
	vi.clearAllMocks()
	mocks.transaction.mockResolvedValue(undefined)
	mocks.findMany.mockImplementation(async () => [theirs])
	mocks.update.mockReturnValue({
		set: () => ({ where: async () => undefined }),
	})
})

describe('reorder and reparent server actions', () => {
	it.each([
		['anonymous', null],
		['a learner', createMongoAbility([{ action: 'read', subject: 'Content' }])],
		['a contributor on someone else’s workshop', contributor('u1')],
	])('refuse %s before writing', async (_name, ability) => {
		as(ability)
		await expect(batchUpdateResourcePositions(unlock)).rejects.toThrow(
			'Unauthorized',
		)
		await expect(
			updateResourcePositions([
				{
					currentParentResourceId: theirs.id,
					parentResourceId: theirs.id,
					resourceId: 'lesson-1',
					position: 0,
				},
			]),
		).rejects.toThrow('Unauthorized')
		await expect(
			updateResourcePosition({
				currentParentResourceId: theirs.id,
				parentResourceId: theirs.id,
				resourceId: 'lesson-1',
				position: 0,
				metadata: { tier: 'free' },
			}),
		).rejects.toThrow('Unauthorized')
		expect(mocks.transaction).not.toHaveBeenCalled()
		expect(mocks.update).not.toHaveBeenCalled()
	})

	it('refuses adding to a tutorial the caller cannot edit', async () => {
		as(contributor('u1'))
		mocks.findFirst.mockResolvedValue({ ...theirs, resources: [] })
		await expect(
			addResourceToTutorial({
				resource: { id: 'lesson-1' } as any,
				tutorialId: theirs.id,
			}),
		).rejects.toThrow('Unauthorized')
		expect(mocks.insert).not.toHaveBeenCalled()
	})

	it('lets a contributor reorder their own workshop', async () => {
		as(contributor('u1'))
		mocks.findMany.mockImplementation(async () => [mine])
		await batchUpdateResourcePositions([
			{
				...unlock[0]!,
				resourceOfId: mine.id,
				currentParentResourceId: mine.id,
			},
		])
		expect(mocks.transaction).toHaveBeenCalledTimes(1)
	})

	it('lets an admin reorder anything', async () => {
		as(createMongoAbility([{ action: 'manage', subject: 'all' }]))
		await batchUpdateResourcePositions(unlock)
		expect(mocks.transaction).toHaveBeenCalledTimes(1)
	})
})

describe('requireContentUpdate', () => {
	it('refuses an id that does not resolve to a resource', async () => {
		as(createMongoAbility([{ action: 'manage', subject: 'all' }]))
		mocks.findMany.mockResolvedValue([])
		await expect(requireContentUpdate(['missing'])).rejects.toThrow(
			'Unauthorized',
		)
	})
})
