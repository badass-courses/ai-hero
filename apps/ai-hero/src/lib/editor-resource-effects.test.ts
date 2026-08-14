import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	revalidatePath: vi.fn(),
	revalidateTag: vi.fn(),
	upsertPostToTypeSense: vi.fn(),
	log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock('next/cache', () => ({
	revalidatePath: mocks.revalidatePath,
	revalidateTag: mocks.revalidateTag,
}))
vi.mock('@/lib/typesense-query', () => ({
	upsertPostToTypeSense: mocks.upsertPostToTypeSense,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))

import { editorResourceEffects } from './editor-resource-effects'
import type { EditorResourceRecord } from './editor-resource'

function workshop(slug: string): EditorResourceRecord {
	return {
		id: 'workshop_1',
		type: 'workshop',
		createdById: 'owner_1',
		fields: {
			title: 'Crash Course',
			slug,
			state: 'published',
			visibility: 'public',
		},
		currentVersionId: 'version_2',
		createdAt: new Date('2026-08-14T00:00:00.000Z'),
		updatedAt: new Date('2026-08-14T00:01:00.000Z'),
		deletedAt: null,
		organizationId: null,
		createdByOrganizationMembershipId: null,
		contributions: [],
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.upsertPostToTypeSense.mockResolvedValue(undefined)
})

describe('editor resource post-commit effects', () => {
	it('runs Typesense and invalidates both old and new workshop paths', async () => {
		await editorResourceEffects.afterWrite({
			action: 'save',
			previousResource: workshop('old-slug'),
			resource: workshop('new-slug'),
			userId: 'editor_1',
		})

		expect(mocks.upsertPostToTypeSense).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'workshop_1' }),
			'save',
		)
		expect(mocks.revalidateTag).toHaveBeenCalledWith('workshop', 'max')
		expect(mocks.revalidateTag).toHaveBeenCalledWith('workshops', 'max')
		expect(mocks.revalidateTag).toHaveBeenCalledWith('workshop_1', 'max')
		expect(mocks.revalidatePath).toHaveBeenCalledWith('/workshops')
		expect(mocks.revalidatePath).toHaveBeenCalledWith('/workshops/old-slug')
		expect(mocks.revalidatePath).toHaveBeenCalledWith('/workshops/new-slug')
	})
})
