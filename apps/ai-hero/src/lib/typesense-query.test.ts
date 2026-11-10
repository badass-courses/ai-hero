import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentResource } from '@coursebuilder/core/schemas'

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	getPostTags: vi.fn(),
	getVideoFacts: vi.fn(),
	log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/server/auth', () => ({ getServerAuthSession: vi.fn() }))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('next/cache', () => ({
	revalidateTag: vi.fn(),
	unstable_cache: (fn: unknown) => fn,
}))
vi.mock('./posts-query', () => ({ getPostTags: mocks.getPostTags }))
vi.mock('./solutions-query', () => ({ getLessonForSolution: vi.fn() }))
vi.mock('./workshops-query', () => ({ getWorkshopsForLesson: vi.fn() }))
vi.mock('./video-resource-query', () => ({ getVideoResource: vi.fn() }))
vi.mock('./video-facts-query', () => ({
	getVideoFactsForResource: mocks.getVideoFacts,
	loadVideoGraph: vi.fn(),
}))
vi.mock('typesense', () => ({
	default: {
		Client: class {
			collections() {
				return { documents: () => ({ create: mocks.create }) }
			}
		},
	},
}))

import { upsertPostToTypeSense } from './typesense-query'

function resource(
	fields: Record<string, unknown>,
	type = 'post',
): ContentResource {
	return {
		id: 'resource-test',
		type,
		createdById: 'author-test',
		createdAt: new Date('2026-01-01'),
		updatedAt: new Date('2026-01-02'),
		fields: {
			title: 'Example',
			slug: 'example',
			visibility: 'public',
			...fields,
		},
		deletedAt: null,
		resources: [],
		organizationId: null,
		createdByOrganizationMembershipId: null,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.stubEnv('TYPESENSE_WRITE_API_KEY', 'test-write-key')
	vi.stubEnv('NEXT_PUBLIC_TYPESENSE_HOST', 'search.example.test')
	mocks.getPostTags.mockResolvedValue([])
	mocks.getVideoFacts.mockResolvedValue(null)
	mocks.create.mockResolvedValue({})
})
afterEach(() => {
	vi.unstubAllEnvs()
})

describe('upsertPostToTypeSense', () => {
	it.each(['post', 'event', 'cohort'])(
		'skips a %s without state before fetching index data',
		async (type) => {
			await expect(
				upsertPostToTypeSense(resource({}, type), 'save'),
			).resolves.toEqual({ ok: false, reason: 'invalid-resource' })
			expect(mocks.create).not.toHaveBeenCalled()
			expect(mocks.getPostTags).not.toHaveBeenCalled()
			expect(mocks.getVideoFacts).not.toHaveBeenCalled()
			expect(mocks.log.info).toHaveBeenCalledWith(
				'typesense.upsert.skip-missing-state',
				{
					postId: 'resource-test',
					resourceType: type,
					action: 'save',
				},
			)
			expect(mocks.log.error).not.toHaveBeenCalled()
		},
	)

	it('does not invent a published state even for a publish action', async () => {
		await upsertPostToTypeSense(resource({}), 'publish')
		expect(mocks.create).not.toHaveBeenCalled()
	})

	it.each(['published', 'draft'])(
		'preserves the existing %s write behavior and popularity value',
		async (state) => {
			await expect(
				upsertPostToTypeSense(resource({ state }), 'save'),
			).resolves.toEqual({ ok: true })
			expect(mocks.create).toHaveBeenCalledWith(
				expect.objectContaining({ state }),
				{ action: 'emplace' },
			)
			expect(mocks.create.mock.calls[0]?.[0]).not.toHaveProperty(
				'popularity_30d',
			)
		},
	)

	it('still reports other invalid fields as validation errors', async () => {
		await expect(
			upsertPostToTypeSense(
				resource({ state: 'published', title: undefined }),
				'save',
			),
		).resolves.toEqual({ ok: false, reason: 'invalid-resource' })
		expect(mocks.create).not.toHaveBeenCalled()
		expect(mocks.log.error).toHaveBeenCalledWith(
			'typesense.resource.validate.error',
			expect.any(Object),
		)
	})
})
