import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	values: vi.fn(),
	upsert: vi.fn(),
	findFirst: vi.fn(),
	update: vi.fn(),
	auth: vi.fn(),
	error: vi.fn(),
}))

vi.mock('next/headers', () => ({
	cookies: async () => ({ get: () => undefined }),
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: {},
	db: {
		query: { resourceProgress: { findFirst: mocks.findFirst } },
		insert: () => ({ values: mocks.values }),
		update: mocks.update,
	},
}))
vi.mock('@/inngest/send-with-retry', () => ({ sendWithRetry: vi.fn() }))
vi.mock('@/lib/find-or-create-user', () => ({
	findOrCreateUserWithPersonalOrg: vi.fn(),
}))
vi.mock('@/server/auth', () => ({ getServerAuthSession: mocks.auth }))
vi.mock('@/server/logger', () => ({
	log: { error: mocks.error, debug: vi.fn() },
	getLogContext: () => undefined,
}))
vi.mock('@/server/perf', () => ({ measureIfSlow: vi.fn() }))
vi.mock('@/schemas/subscriber', () => ({ SubscriberSchema: {} }))

import { setPlaybackPositionForResource } from './progress'

const save = (positionSeconds: number) =>
	setPlaybackPositionForResource({ resourceId: 'lesson-1', positionSeconds })

beforeEach(() => {
	vi.resetAllMocks()
	mocks.auth.mockResolvedValue({ session: { user: { id: 'user-1' } } })
	mocks.values.mockReturnValue({ onDuplicateKeyUpdate: mocks.upsert })
	mocks.upsert.mockResolvedValue(undefined)
})

describe('playback position atomic save', () => {
	it('inserts a normalized position without a preliminary progress read', async () => {
		expect(await save(42.8)).toBe(42)
		expect(mocks.values).toHaveBeenCalledOnce()
		expect(mocks.values).toHaveBeenCalledWith({
			userId: 'user-1',
			resourceId: 'lesson-1',
			fields: { playbackPositionSeconds: 42 },
			completedAt: null,
			updatedAt: expect.any(Date),
		})
		expect(mocks.upsert).toHaveBeenCalledOnce()
		expect(mocks.findFirst).not.toHaveBeenCalled()
		expect(mocks.update).not.toHaveBeenCalled()
	})

	it('patches only the position on subsequent saves, preserving fields and completion', async () => {
		await save(42)
		await save(75.9)
		expect(mocks.values).toHaveBeenCalledTimes(2)
		expect(mocks.upsert).toHaveBeenCalledTimes(2)
		const { set } = mocks.upsert.mock.calls[1]![0]
		// No completedAt assignment on the duplicate path. JSON_SET operates
		// on the stored document, not a stale client-side copy of its fields.
		expect(Object.keys(set).sort()).toEqual(['fields', 'updatedAt'])
		const query = new MySqlDialect().sqlToQuery(set.fields)
		expect(query.sql).toBe(
			"JSON_SET(COALESCE(`AI_ResourceProgress`.`fields`, JSON_OBJECT()), '$.playbackPositionSeconds', ?)",
		)
		expect(query.params).toEqual([75])
		expect(set.updatedAt).toEqual(mocks.values.mock.calls[1]![0].updatedAt)
		expect(mocks.findFirst).not.toHaveBeenCalled()
		expect(mocks.update).not.toHaveBeenCalled()
	})

	it('saves zero for an ended source', async () => {
		expect(await save(0)).toBe(0)
		expect(mocks.values.mock.calls[0]![0].fields).toEqual({
			playbackPositionSeconds: 0,
		})
	})

	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
		'ignores an invalid position (%s) without authentication or a write',
		async (position) => {
			expect(await save(position)).toBeNull()
			expect(mocks.auth).not.toHaveBeenCalled()
			expect(mocks.values).not.toHaveBeenCalled()
		},
	)

	it('does not save without a user', async () => {
		mocks.auth.mockResolvedValue({ session: null })
		expect(await save(42)).toBeNull()
		expect(mocks.values).not.toHaveBeenCalled()
	})

	it('preserves the existing failure result and error log', async () => {
		mocks.upsert.mockRejectedValue(new Error('write failed'))
		expect(await save(42)).toBeNull()
		expect(mocks.error).toHaveBeenCalledOnce()
		expect(mocks.error).toHaveBeenCalledWith(
			'progress.playback-position.set.error',
			{ resourceId: 'lesson-1', error: 'write failed' },
		)
	})
})
