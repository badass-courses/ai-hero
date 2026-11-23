import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execute, logError, logWarn, values, unstableCache } = vi.hoisted(() => {
	const values = new Map<string, string | null>()

	return {
		execute: vi.fn(),
		logError: vi.fn(),
		logWarn: vi.fn(),
		values,
		// Model a Data Cache that only records fulfilled callbacks.
		unstableCache: vi.fn(
			(read: () => Promise<string | null>, key: string[]) => async () => {
				const keyString = JSON.stringify(key)
				const cached = values.get(keyString)
				if (cached !== undefined) return cached
				const result = await read()
				values.set(keyString, result)
				return result
			},
		),
	}
})

vi.mock('next/cache', () => ({ unstable_cache: unstableCache }))
vi.mock('@/db', () => ({ db: { execute } }))
vi.mock('@/db/schema', () => ({
	contentResource: 'ContentResource',
	contentResourceResource: 'ContentResourceResource',
}))
vi.mock('@/server/logger', () => ({
	log: { error: logError, warn: logWarn },
}))
vi.mock('@/server/perf', () => ({
	measureIfSlow: ({ operation }: { operation: () => Promise<unknown> }) =>
		operation(),
}))

import {
	getCachedLessonVideoTranscript,
	getUncachedLessonVideoTranscript,
} from './lesson-transcript-cache'

describe('lesson transcript cache', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		execute.mockReset()
		values.clear()
	})

	it('returns null on a DB error without caching the failure', async () => {
		execute
			.mockRejectedValueOnce(new Error('DB unavailable'))
			.mockResolvedValueOnce({ rows: [{ transcript: 'Recovered transcript' }] })

		await expect(getCachedLessonVideoTranscript('lesson-1')).resolves.toBeNull()
		expect(logError).toHaveBeenCalledWith('lesson.transcript.fetch_failed', {
			lessonIdOrSlug: 'lesson-1',
			error: 'DB unavailable',
			stack: expect.any(String),
		})
		expect(values.size).toBe(0)
		await expect(getCachedLessonVideoTranscript('lesson-1')).resolves.toBe(
			'Recovered transcript',
		)
		await expect(getCachedLessonVideoTranscript('lesson-1')).resolves.toBe(
			'Recovered transcript',
		)
		expect(execute).toHaveBeenCalledTimes(2)
	})

	it('caches each lesson separately with both invalidation tags', async () => {
		execute
			.mockResolvedValueOnce({ rows: [] })
			.mockResolvedValueOnce({ rows: [{ transcript: 'Second lesson' }] })

		await expect(getCachedLessonVideoTranscript('lesson-1')).resolves.toBeNull()
		await expect(getCachedLessonVideoTranscript('lesson-2')).resolves.toBe(
			'Second lesson',
		)
		await expect(getCachedLessonVideoTranscript('lesson-1')).resolves.toBeNull()
		expect(execute).toHaveBeenCalledTimes(2)
		expect(unstableCache).toHaveBeenCalledWith(
			expect.any(Function),
			['lesson-video-transcript-v1', 'lesson-1'],
			{
				revalidate: 600,
				tags: ['lesson-video-transcript', 'lesson-video-transcript:lesson-1'],
			},
		)
	})

	it('bypasses the cache for the uncached caller', async () => {
		execute
			.mockResolvedValueOnce({ rows: [{ transcript: 'Before' }] })
			.mockResolvedValueOnce({ rows: [{ transcript: 'After' }] })

		await expect(getUncachedLessonVideoTranscript('lesson-1')).resolves.toBe(
			'Before',
		)
		await expect(getUncachedLessonVideoTranscript('lesson-1')).resolves.toBe(
			'After',
		)
		expect(unstableCache).not.toHaveBeenCalled()
	})
})
