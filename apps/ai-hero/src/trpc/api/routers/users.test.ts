import { createMongoAbility } from '@casl/ability'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	findMany: vi.fn(),
	where: vi.fn(),
	set: vi.fn(),
	update: vi.fn(),
	warn: vi.fn(),
}))
vi.mock('@/db', () => ({
	db: {
		query: {
			users: { findFirst: mocks.findFirst },
			accounts: { findMany: mocks.findMany },
		},
		update: mocks.update,
	},
}))
vi.mock('@/server/auth', () => ({ getServerAuthSession: vi.fn() }))
vi.mock('@/server/logger', () => ({ log: { warn: mocks.warn } }))
vi.mock('@/lib/incoming-transfers', () => ({ getIncomingTransfer: vi.fn() }))
vi.mock('@/lib/playback-prefs-query', () => ({
	getPlaybackPrefsForUser: vi.fn(),
	setPlaybackPrefsForUser: vi.fn(),
}))

import { usersRouter } from './users'

function caller(role: 'anonymous' | 'self' | 'admin' = 'self') {
	return usersRouter.createCaller({
		session: role === 'anonymous' ? null : { user: { id: 'self' } },
		ability: createMongoAbility(
			role === 'admin'
				? [{ action: 'manage', subject: 'all' }]
				: [
						{
							action: ['read', 'update'],
							subject: 'User',
							conditions: { id: 'self' },
						},
					],
		),
		headers: new Headers(),
		db: {},
	} as any)
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.update.mockReturnValue({ set: mocks.set })
	mocks.set.mockReturnValue({ where: mocks.where })
	mocks.where.mockResolvedValue(undefined)
})

describe('users access and picked outputs', () => {
	it('rejects anonymous requests before reading or writing', async () => {
		await expect(
			caller('anonymous').get({ userId: 'self' }),
		).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
		await expect(
			caller('anonymous').updateName({ name: 'New' }),
		).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
		// Intentional step-1 change: anonymous githubConnected used to return false.
		await expect(caller('anonymous').githubConnected()).rejects.toMatchObject({
			code: 'UNAUTHORIZED',
		})
		expect(mocks.findFirst).not.toHaveBeenCalled()
		expect(mocks.findMany).not.toHaveBeenCalled()
		expect(mocks.update).not.toHaveBeenCalled()
	})
	it('returns identical errors for another user and a nonexistent id without fetching', async () => {
		const errors = []
		for (const userId of ['other', 'nonexistent']) {
			try {
				await caller().get({ userId })
			} catch (error) {
				const denied = error as { code: string; message: string }
				errors.push({ code: denied.code, message: denied.message })
			}
		}
		expect(errors).toEqual([
			{ code: 'FORBIDDEN', message: 'FORBIDDEN' },
			{ code: 'FORBIDDEN', message: 'FORBIDDEN' },
		])
		expect(mocks.findFirst).not.toHaveBeenCalled()
	})
	it.each(['self', 'admin'] as const)(
		'allows %s and strips non-allowlisted fields',
		async (role) => {
			const row = {
				id: role === 'self' ? 'self' : 'other',
				name: 'Test',
				email: 'test@example.test',
				image: null,
				role: 'user',
				fields: { private: true },
				emailVerified: new Date(),
			}
			mocks.findFirst.mockResolvedValue(row)
			expect(await caller(role).get({ userId: row.id })).toEqual({
				id: row.id,
				name: row.name,
				email: row.email,
				image: null,
				role: 'user',
			})
		},
	)
	it('preserves a missing own row or admin lookup as undefined', async () => {
		mocks.findFirst.mockResolvedValue(undefined)
		expect(await caller().get({ userId: 'self' })).toBeUndefined()
		expect(await caller('admin').get({ userId: 'missing' })).toBeUndefined()
	})
	it('preserves connected/disconnected results for authenticated callers', async () => {
		mocks.findMany.mockResolvedValue([])
		expect(await caller().githubConnected()).toBe(false)
		mocks.findMany.mockResolvedValue([{ provider: 'github' }])
		expect(await caller().githubConnected()).toBe(true)
	})
	it('updates a name and preserves persistence failures', async () => {
		expect(await caller().updateName({ name: 'New' })).toEqual({ name: 'New' })
		expect(mocks.set).toHaveBeenCalledWith({ name: 'New' })
		mocks.where.mockRejectedValue(new Error('synthetic persistence failure'))
		await expect(caller().updateName({ name: 'New' })).rejects.toMatchObject({
			code: 'INTERNAL_SERVER_ERROR',
			message: 'Failed to update name',
		})
	})
})
