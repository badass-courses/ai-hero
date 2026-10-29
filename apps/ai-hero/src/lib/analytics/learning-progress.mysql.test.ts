import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SQL } from 'drizzle-orm'

import {
	expectedLearningProgress,
	LEARNING_AS_OF,
	learningFixture,
} from './learning-progress.fixtures'
import { createLearningDatabase } from './learning-progress.mysql-fixture'
import {
	LearningProductNotFoundError,
	readLearningProgress,
} from './learning-progress-query'

vi.mock('@/db', () => ({}))

const url = process.env.AIH_MYSQL_TEST_URL

describe.skipIf(!url)('learning progress SQL (synthetic MySQL)', () => {
	let database: Awaited<ReturnType<typeof createLearningDatabase>>
	let execute: (query: SQL) => Promise<unknown>

	beforeAll(async () => {
		database = await createLearningDatabase(url!, learningFixture, 'learning')
		execute = database.execute
	})

	afterAll(async () => {
		await database?.close()
	})

	it('reads the fixture product exactly', async () => {
		expect(
			await readLearningProgress(
				execute,
				learningFixture.productId,
				LEARNING_AS_OF,
			),
		).toEqual(expectedLearningProgress)
	})

	it('returns only count columns from MySQL', async () => {
		const queries: SQL[] = []
		const results: unknown[] = []
		await readLearningProgress(
			async (query) => {
				queries.push(query)
				const result = await execute(query)
				results.push(result)
				return result
			},
			learningFixture.productId,
			LEARNING_AS_OF,
		)
		// Product, roots, three structure levels, roster, progress.
		const [roster, progress] = results.slice(-2) as {
			rows: Record<string, unknown>[]
		}[]
		for (const result of [roster!, progress!]) {
			expect(result.rows).toHaveLength(1)
			expect(Object.keys(result.rows[0]!).join(',')).not.toMatch(
				/userId|email|name/i,
			)
		}
	})

	it('reports an unknown product rather than an empty funnel', async () => {
		await expect(
			readLearningProgress(execute, 'no-such-product', LEARNING_AS_OF),
		).rejects.toBeInstanceOf(LearningProductNotFoundError)
	})
})
