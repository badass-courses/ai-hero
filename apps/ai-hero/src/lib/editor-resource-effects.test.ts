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

function workshop(
	slug: string,
	overrides: Partial<EditorResourceRecord> = {},
): EditorResourceRecord {
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
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.revalidatePath.mockReset()
	mocks.revalidateTag.mockReset()
	mocks.upsertPostToTypeSense.mockReset()
	mocks.upsertPostToTypeSense.mockResolvedValue({ ok: true })
})

describe('editor resource post-commit effects', () => {
	it('runs Typesense and invalidates both old and new workshop paths', async () => {
		const resource = workshop('new-slug')
		const warnings = await editorResourceEffects.afterWrite({
			action: 'save',
			previousResource: workshop('old-slug'),
			resource,
			userId: 'editor_1',
			getCurrentResource: async () => resource,
		})

		expect(warnings).toEqual([])
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

	it('repairs an older request that completes after a newer write', async () => {
		const versionA = workshop('stable-slug', {
			currentVersionId: 'version_a',
			fields: { ...workshop('stable-slug').fields, body: 'A' },
		})
		const versionB = workshop('stable-slug', {
			currentVersionId: 'version_b',
			fields: { ...workshop('stable-slug').fields, body: 'B' },
		})
		let current = versionA
		let releaseA!: () => void
		let markAStarted!: () => void
		const aStarted = new Promise<void>((resolve) => {
			markAStarted = resolve
		})
		const aRelease = new Promise<void>((resolve) => {
			releaseA = resolve
		})
		const completionOrder: string[] = []

		mocks.upsertPostToTypeSense.mockImplementation(async (candidate) => {
			if (candidate.currentVersionId === 'version_a') {
				markAStarted()
				await aRelease
			}
			completionOrder.push(candidate.currentVersionId)
			return { ok: true }
		})

		const requestA = editorResourceEffects.afterWrite({
			action: 'save',
			previousResource: workshop('stable-slug', {
				currentVersionId: 'version_0',
			}),
			resource: versionA,
			userId: 'editor_a',
			getCurrentResource: async () => current,
		})
		await aStarted

		current = versionB
		const requestB = editorResourceEffects.afterWrite({
			action: 'save',
			previousResource: versionA,
			resource: versionB,
			userId: 'editor_b',
			getCurrentResource: async () => current,
		})
		await requestB
		releaseA()
		await requestA

		expect(completionOrder).toEqual(['version_b', 'version_a', 'version_b'])
		expect(completionOrder.at(-1)).toBe(current.currentVersionId)
	})

	it('returns a warning after a committed write when Typesense fails', async () => {
		mocks.upsertPostToTypeSense.mockRejectedValue(new Error('search down'))
		const resource = workshop('new-slug')

		await expect(
			editorResourceEffects.afterWrite({
				action: 'save',
				previousResource: workshop('old-slug'),
				resource,
				userId: 'editor_1',
				getCurrentResource: async () => resource,
			}),
		).resolves.toEqual([expect.objectContaining({ effect: 'typesense' })])
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'editor.resource.typesense.failed',
			expect.objectContaining({ error: 'search down' }),
		)
	})

	it('returns a warning after a committed write when Typesense degrades', async () => {
		mocks.upsertPostToTypeSense.mockResolvedValue({
			ok: false,
			reason: 'write-failed',
		})
		const resource = workshop('new-slug')

		await expect(
			editorResourceEffects.afterWrite({
				action: 'save',
				previousResource: workshop('old-slug'),
				resource,
				userId: 'editor_1',
				getCurrentResource: async () => resource,
			}),
		).resolves.toEqual([expect.objectContaining({ effect: 'typesense' })])
	})

	it('returns a warning after a committed write when cache invalidation fails', async () => {
		mocks.revalidateTag.mockImplementationOnce(() => {
			throw new Error('cache down')
		})
		const resource = workshop('new-slug')

		await expect(
			editorResourceEffects.afterWrite({
				action: 'save',
				previousResource: workshop('old-slug'),
				resource,
				userId: 'editor_1',
				getCurrentResource: async () => resource,
			}),
		).resolves.toEqual([expect.objectContaining({ effect: 'cache' })])
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'editor.resource.cache-invalidation.failed',
			expect.objectContaining({ error: 'cache down' }),
		)
		expect(mocks.log.info).toHaveBeenCalledWith(
			'editor.resource.write.completed',
			expect.objectContaining({ versionId: 'version_2' }),
		)
	})
})
