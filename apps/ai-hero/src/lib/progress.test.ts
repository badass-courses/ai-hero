import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	send: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	insert: vi.fn(),
	update: vi.fn(),
	findFirst: vi.fn(),
	findUser: vi.fn(),
	execute: vi.fn(),
}))

vi.mock('next/headers', () => ({
	cookies: vi.fn(),
	headers: async () => new Headers({ 'x-vercel-id': 'iad1::req-123' }),
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: {},
	db: {
		query: {
			resourceProgress: { findFirst: mocks.findFirst },
			users: { findFirst: mocks.findUser },
		},
		execute: mocks.execute,
		insert: () => ({ values: mocks.insert }),
		update: () => ({ set: () => ({ where: mocks.update }) }),
	},
}))
vi.mock('@/db/schema', () => ({
	contentResource: 'contentResource',
	contentResourceResource: 'contentResourceResource',
	resourceProgress: { resourceId: 'resourceId', userId: 'userId' },
	users: { id: 'id', email: 'email' },
}))
vi.mock('drizzle-orm', () => ({
	and: vi.fn(),
	eq: vi.fn(),
	or: vi.fn(),
	sql: vi.fn(() => ({})),
}))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { send: mocks.send },
}))
vi.mock('@/lib/find-or-create-user', () => ({
	findOrCreateUserWithPersonalOrg: vi.fn(),
}))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: async () => ({
		session: { user: { id: 'user-1', email: 'learner@example.test' } },
	}),
}))
vi.mock('@/server/logger', () => ({
	log: { warn: mocks.warn, error: mocks.error, debug: vi.fn() },
	getLogContext: () => undefined,
}))
vi.mock('@/server/perf', () => ({ measureIfSlow: vi.fn() }))
vi.mock('@/schemas/subscriber', () => ({ SubscriberSchema: {} }))

import { getModuleProgressForIdentity } from './module-progress-query'
import { setProgressForResource } from './progress'

describe('getModuleProgressForIdentity', () => {
	it('keeps a finished workshop at 100 percent after an optional FAQ is added', async () => {
		mocks.findUser.mockResolvedValue({ id: 'learner' })
		mocks.execute.mockResolvedValue({
			rows: [
				{
					resource_id: 'before-we-start',
					resource_type: 'lesson',
					resource_slug: 'before-we-start',
					completed_at: '2026-11-01T10:00:00.000Z',
					is_optional: 'false',
				},
				{
					resource_id: 'faq',
					resource_type: 'lesson',
					resource_slug: 'faq',
					completed_at: null,
					is_optional: 'true',
				},
			],
		})

		const progress = await getModuleProgressForIdentity('learner', 'workshop')

		expect(progress).toMatchObject({
			completedLessonsCount: 1,
			totalLessonsCount: 1,
			percentCompleted: 100,
			nextResource: null,
		})
	})
})

describe('setProgressForResource Inngest send handling', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.findFirst.mockResolvedValue(undefined)
		mocks.insert.mockResolvedValue(undefined)
	})

	it('saves and returns progress when every send attempt fails', async () => {
		mocks.send.mockRejectedValue(new TypeError('fetch failed'))

		const progress = await setProgressForResource({
			resourceId: 'lesson-1',
			isCompleted: true,
		})

		expect(mocks.insert).toHaveBeenCalledOnce()
		expect(progress).toMatchObject({
			userId: 'user-1',
			resourceId: 'lesson-1',
		})
		expect(mocks.send).toHaveBeenCalledTimes(3)
		expect(mocks.warn).toHaveBeenCalledOnce()
		expect(mocks.warn.mock.calls[0]![0]).toBe('progress.inngest_send_failed')
		expect(mocks.error).not.toHaveBeenCalled()
		const logged = JSON.stringify(mocks.warn.mock.calls)
		expect(logged).not.toContain('user-1')
		expect(logged).not.toContain('learner@example.test')
	})

	it('retries once and stays quiet when the second send succeeds', async () => {
		mocks.send
			.mockRejectedValueOnce(new TypeError('fetch failed'))
			.mockResolvedValueOnce({ ids: ['e1'] })

		const progress = await setProgressForResource({
			resourceId: 'lesson-1',
			isCompleted: true,
		})

		expect(progress).not.toBeNull()
		expect(mocks.send).toHaveBeenCalledTimes(2)
		expect(mocks.warn).not.toHaveBeenCalled()
	})
})
