import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	revalidatePath: vi.fn(),
	revalidateTag: vi.fn(),
	send: vi.fn(),
	log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock('next/cache', () => ({
	revalidatePath: mocks.revalidatePath,
	revalidateTag: mocks.revalidateTag,
}))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { send: mocks.send },
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))

import { editorResourceEffects } from './editor-resource-effects'
import type { EditorResourceRecord } from './editor-resource'

function resource(
	type: 'page' | 'workshop',
	slug: string,
	overrides: Partial<EditorResourceRecord> = {},
): EditorResourceRecord {
	return {
		id: `${type}_1`,
		type,
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
	mocks.send.mockReset()
	mocks.send.mockResolvedValue({ ids: ['event_1'] })
})

describe('editor resource post-commit effects', () => {
	it('queues immutable version-bound indexing and invalidates caches', async () => {
		const result = await editorResourceEffects.afterWrite({
			action: 'save',
			previousResource: resource('workshop', 'stable-slug', {
				currentVersionId: 'version_1',
			}),
			resource: resource('workshop', 'stable-slug'),
			userId: 'editor_1',
		})

		expect(result).toEqual({
			effects: { typesense: 'queued', cache: 'completed' },
			warnings: [],
		})
		expect(mocks.send).toHaveBeenCalledWith({
			id: 'content-resource-index:workshop_1:version_2',
			name: 'content/resource.index-requested',
			data: {
				resourceId: 'workshop_1',
				committedVersionId: 'version_2',
			},
		})
		expect(mocks.revalidateTag).toHaveBeenCalledWith('workshop', 'max')
		expect(mocks.revalidateTag).toHaveBeenCalledWith('workshops', 'max')
		expect(mocks.revalidateTag).toHaveBeenCalledWith('workshop_1', 'max')
		expect(mocks.revalidatePath).toHaveBeenCalledWith('/workshops')
		expect(mocks.revalidatePath).toHaveBeenCalledWith('/workshops/stable-slug')
	})

	it('returns degraded indexing state when enqueue fails', async () => {
		mocks.send.mockRejectedValue(new Error('Inngest unavailable'))

		await expect(
			editorResourceEffects.afterWrite({
				action: 'save',
				previousResource: resource('workshop', 'stable-slug'),
				resource: resource('workshop', 'stable-slug'),
				userId: 'editor_1',
			}),
		).resolves.toEqual({
			effects: { typesense: 'degraded', cache: 'completed' },
			warnings: [expect.objectContaining({ effect: 'typesense' })],
		})
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'editor.resource.typesense.enqueue-failed',
			expect.objectContaining({ error: 'Inngest unavailable' }),
		)
	})

	it('does not report queued when Inngest accepts no event', async () => {
		mocks.send.mockResolvedValue({ ids: [] })

		const result = await editorResourceEffects.afterWrite({
			action: 'save',
			previousResource: resource('workshop', 'stable-slug'),
			resource: resource('workshop', 'stable-slug'),
			userId: 'editor_1',
		})

		expect(result.effects.typesense).toBe('degraded')
		expect(result.warnings).toEqual([
			expect.objectContaining({ effect: 'typesense' }),
		])
	})

	it('returns degraded cache state without losing queued indexing', async () => {
		mocks.revalidateTag.mockImplementationOnce(() => {
			throw new Error('cache down')
		})

		await expect(
			editorResourceEffects.afterWrite({
				action: 'save',
				previousResource: resource('workshop', 'stable-slug'),
				resource: resource('workshop', 'stable-slug'),
				userId: 'editor_1',
			}),
		).resolves.toEqual({
			effects: { typesense: 'queued', cache: 'degraded' },
			warnings: [expect.objectContaining({ effect: 'cache' })],
		})
		expect(mocks.send).toHaveBeenCalledOnce()
	})

	it('marks page indexing not applicable and invalidates its cache', async () => {
		const result = await editorResourceEffects.afterWrite({
			action: 'save',
			previousResource: resource('page', 'page-slug'),
			resource: resource('page', 'page-slug'),
			userId: 'editor_1',
		})

		expect(result.effects).toEqual({
			typesense: 'not-applicable',
			cache: 'completed',
		})
		expect(mocks.send).not.toHaveBeenCalled()
		expect(mocks.revalidateTag).toHaveBeenCalledWith('pages', 'max')
		expect(mocks.revalidatePath).toHaveBeenCalledWith('/page-slug')
	})
})
