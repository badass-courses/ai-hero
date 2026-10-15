import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	getCachedSolution: vi.fn(),
}))

vi.mock('@/db', () => ({
	db: { query: { contentResource: { findFirst: mocks.findFirst } } },
	courseBuilderAdapter: {},
}))
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/lib/typesense-query', () => ({ upsertPostToTypeSense: vi.fn() }))
vi.mock('@/server/auth', () => ({ getServerAuthSession: vi.fn() }))
vi.mock('@/server/logger', () => ({
	log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))
vi.mock('@upstash/redis', () => ({ Redis: { fromEnv: () => ({}) } }))
vi.mock('./solutions-query', () => ({
	getCachedSolution: mocks.getCachedSolution,
	getSolution: vi.fn(),
}))

import { getExerciseSolution } from './lessons-query'

const now = new Date()

function lesson(resources: unknown[]) {
	return {
		id: 'lesson-1',
		type: 'lesson',
		createdById: 'user-1',
		createdAt: now,
		updatedAt: now,
		deletedAt: null,
		organizationId: null,
		createdByOrganizationMembershipId: null,
		fields: { slug: 'lesson-1', title: 'Lesson', state: 'published', visibility: 'public' },
		resources,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('getExerciseSolution', () => {
	it('is null for a lesson without a solution, so the page can 404', async () => {
		mocks.findFirst.mockResolvedValue(
			lesson([
				{
					resourceId: 'video-1',
					resourceOfId: 'lesson-1',
					position: 0,
					metadata: {},
					createdAt: now,
					updatedAt: now,
					deletedAt: null,
					resource: { id: 'video-1', type: 'videoResource' },
				},
			]),
		)

		await expect(getExerciseSolution('lesson-1')).resolves.toBeNull()
		expect(mocks.getCachedSolution).not.toHaveBeenCalled()
	})
})
