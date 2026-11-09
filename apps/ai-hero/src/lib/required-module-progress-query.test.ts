import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
const mocks = vi.hoisted(() => ({ adapter: vi.fn(), execute: vi.fn() }))
vi.mock('@/db', () => ({
	db: { execute: mocks.execute },
	courseBuilderAdapter: { getModuleProgressForUser: mocks.adapter },
}))
import { getRequiredModuleProgressForUser } from './required-module-progress-query'

beforeEach(() => { vi.clearAllMocks() })
describe('required module progress query', () => {
	it('projects live ordered rows while retaining optional completion', async () => {
		mocks.adapter.mockResolvedValue({
			completedLessons: [
				{ userId: 'learner', resourceId: 'faq', completedAt: new Date() },
			],
			nextResource: { id: 'faq' },
			percentCompleted: 50,
			totalLessonsCount: 2,
			completedLessonsCount: 1,
		})
		mocks.execute.mockResolvedValue({
			rows: [
				{ id: 'faq', type: 'lesson', slug: 'faq', optional: 'true' },
				{ id: 'required', type: 'lesson', slug: 'required', optional: null },
			],
		})
		const result = await getRequiredModuleProgressForUser('learner', 'workshop')
		expect(result).toMatchObject({
			completedLessonsCount: 0,
			totalLessonsCount: 1,
			percentCompleted: 0,
			nextResource: { id: 'required' },
			optionalLessonIds: ['faq'],
		})
		expect(result?.completedLessons).toHaveLength(1)
		const query = new MySqlDialect().sqlToQuery(mocks.execute.mock.calls[0]![0])
		expect(query.sql).toContain(
			'crr.deletedAt IS NULL AND cr.deletedAt IS NULL',
		)
		expect(query.sql).toContain("s.type = 'section'")
		expect(query.sql).toContain('ORDER BY global_order')
		expect(query.params).toEqual(['workshop', 'workshop'])
	})
	it('does not query a module for an unknown learner', async () => {
		mocks.adapter.mockResolvedValue(null)
		expect(
			await getRequiredModuleProgressForUser('missing', 'workshop'),
		).toBeNull()
		expect(mocks.execute).not.toHaveBeenCalled()
	})
})
