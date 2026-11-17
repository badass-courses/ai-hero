import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	get: vi.fn(),
	set: vi.fn(),
}))

vi.mock('@/db', () => ({
	db: { query: { contentResource: { findFirst: mocks.findFirst } } },
	courseBuilderAdapter: {},
}))
vi.mock('@/env.mjs', () => ({ env: { NEXT_PUBLIC_APP_NAME: 'lookup-test' } }))
vi.mock('@/lib/typesense-query', () => ({ upsertPostToTypeSense: vi.fn() }))
vi.mock('@/server/auth', () => ({ getServerAuthSession: vi.fn() }))
vi.mock('@/server/logger', () => ({
	log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	serializeError: (error: unknown) => error,
}))
vi.mock('@upstash/redis', () => ({
	Redis: { fromEnv: () => ({ get: mocks.get, set: mocks.set }) },
}))
vi.mock('./solutions-query', () => ({
	getCachedSolution: vi.fn(),
	getSolution: vi.fn(),
}))

import { log } from '@/server/logger'

import { LessonSchema } from './lessons'
import { getLesson } from './lessons-query'

const row = {
	id: 'lesson-abc',
	type: 'lesson',
	createdById: 'user-1',
	createdAt: new Date('2026-01-01'),
	updatedAt: null,
	deletedAt: null,
	organizationId: null,
	createdByOrganizationMembershipId: null,
	fields: { slug: 'my-lesson-abc', title: 'A lesson' },
	resources: [],
	tags: [],
}
const positiveKey = 'lesson:lookup-test:my-lesson-abc'
const negativeKey = 'lesson:not-found:lookup-test:my-lesson-abc'
const dialect = new MySqlDialect()

beforeEach(() => {
	vi.resetAllMocks()
	mocks.get.mockResolvedValue(null)
	mocks.set.mockResolvedValue('OK')
	mocks.findFirst.mockResolvedValue(undefined)
})

describe('getLesson staged lookup', () => {
	it.each([1, 2, 3])(
		'stops after stage %i and retains the relation selection',
		async (stage) => {
			for (let index = 1; index < stage; index++) {
				mocks.findFirst.mockResolvedValueOnce(undefined)
			}
			mocks.findFirst.mockResolvedValueOnce(row)

			await expect(getLesson('my-lesson-abc')).resolves.toEqual(
				LessonSchema.parse(row),
			)
			expect(mocks.findFirst).toHaveBeenCalledTimes(stage)
			for (const [options] of mocks.findFirst.mock.calls) {
				expect(options.with).toEqual({
					tags: { with: { tag: true }, orderBy: expect.anything() },
					resources: { with: { resource: { columns: { type: true } } } },
				})
				const ordering = dialect.sqlToQuery(options.with.tags.orderBy)
				expect(ordering.sql).toMatch(/position.*asc/)
			}
			const queries = mocks.findFirst.mock.calls.map(([options]) =>
				dialect.sqlToQuery(options.where),
			)
			expect(queries[0]?.sql).toMatch(/`id` = \?/)
			expect(queries[0]?.sql).not.toMatch(/JSON_EXTRACT|like/i)
			expect(queries[0]?.params).toEqual([
				'my-lesson-abc',
				'lesson',
				'exercise',
				'solution',
				'post',
			])
			if (stage >= 2) {
				const orderBy = mocks.findFirst.mock.calls[1]?.[0].orderBy
				expect(
					orderBy.map(
						(order: Parameters<typeof dialect.sqlToQuery>[0]) =>
							dialect.sqlToQuery(order).sql,
					),
				).toEqual([
					expect.stringMatching(/`type` asc/),
					expect.stringMatching(/`id` asc/),
				])
				expect(queries[1]?.sql).toContain('JSON_EXTRACT')
				expect(queries[1]?.sql).not.toMatch(/like/i)
				expect(queries[1]?.params).toEqual([
					'my-lesson-abc',
					'lesson',
					'exercise',
					'solution',
					'post',
				])
			}
			if (stage === 3) {
				expect(queries[2]?.sql).toMatch(/`id` like \?/)
				expect(queries[2]?.params).toEqual([
					'%abc%',
					'lesson',
					'exercise',
					'solution',
					'post',
				])
			}
			expect(mocks.set).toHaveBeenCalledTimes(1)
			expect(mocks.set).toHaveBeenCalledWith(positiveKey, row, { ex: 10 })
		},
	)

	it('returns a positive cache hit without checking the negative cache or database', async () => {
		mocks.get.mockResolvedValue(row)
		await expect(getLesson('my-lesson-abc')).resolves.toEqual(
			LessonSchema.parse(row),
		)
		expect(mocks.get).toHaveBeenCalledTimes(1)
		expect(mocks.get).toHaveBeenCalledWith(positiveKey)
		expect(mocks.findFirst).not.toHaveBeenCalled()
		expect(mocks.set).not.toHaveBeenCalled()
	})

	it('caches a complete miss separately for 60 seconds and skips all stages on the next call', async () => {
		const cache = new Map<string, unknown>()
		mocks.get.mockImplementation(async (key: string) => cache.get(key) ?? null)
		mocks.set.mockImplementation(async (key: string, value: unknown) =>
			cache.set(key, value),
		)

		await expect(getLesson('my-lesson-abc')).resolves.toBeNull()
		await expect(getLesson('my-lesson-abc')).resolves.toBeNull()
		expect(mocks.findFirst).toHaveBeenCalledTimes(3)
		expect(mocks.set).toHaveBeenCalledTimes(1)
		expect(mocks.set).toHaveBeenCalledWith(negativeKey, true, { ex: 60 })
		expect(log.debug).toHaveBeenCalledTimes(2)
		expect(log.debug).toHaveBeenCalledWith('lesson.not_found', {
			slug: 'my-lesson-abc',
		})
		expect(log.error).not.toHaveBeenCalled()
	})

	it('queries again once the negative cache expires', async () => {
		mocks.get.mockResolvedValueOnce(null).mockResolvedValueOnce(true)
		await expect(getLesson('my-lesson-abc')).resolves.toBeNull()
		expect(mocks.findFirst).not.toHaveBeenCalled()

		// Redis no longer returns the marker after its TTL.
		mocks.findFirst.mockResolvedValueOnce(row)
		await expect(getLesson('my-lesson-abc')).resolves.toEqual(
			LessonSchema.parse(row),
		)
		expect(mocks.findFirst).toHaveBeenCalledTimes(1)
		expect(mocks.set).toHaveBeenCalledWith(positiveKey, row, { ex: 10 })
	})

	it('does not cache a schema failure or fall through to another match', async () => {
		mocks.findFirst.mockResolvedValueOnce({ id: 'lesson-abc', type: 'lesson' })
		await expect(getLesson('my-lesson-abc')).resolves.toBeNull()
		expect(mocks.findFirst).toHaveBeenCalledTimes(1)
		expect(mocks.set).not.toHaveBeenCalled()
		expect(log.error).toHaveBeenCalledWith(
			'lesson.parse.error',
			expect.objectContaining({ source: 'getLesson' }),
		)
	})

	it('does not cache database failures as not found', async () => {
		mocks.findFirst.mockRejectedValueOnce(new Error('database unavailable'))
		await expect(getLesson('my-lesson-abc')).rejects.toThrow(
			'database unavailable',
		)
		expect(mocks.set).not.toHaveBeenCalled()
	})
})
