import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { describe, expect, it } from 'vitest'

import { DrizzleCaptureMarketingRepository } from './drizzle-capture-repository'

describe('findPendingValuePathEmailSideEffectIntents query shape', () => {
	it('excludes completed rows in SQL instead of fetching and discarding them', async () => {
		let capturedWhere: unknown
		const database = {
			select: () => ({
				from: () => ({
					where: async (condition: unknown) => {
						capturedWhere = condition
						return []
					},
				}),
			}),
		}
		const repository = new DrizzleCaptureMarketingRepository(database)

		const result = await repository.findPendingValuePathEmailSideEffectIntents({
			limit: 10,
		})

		expect(result).toEqual([])
		expect(capturedWhere).toBeDefined()
		const rendered = new MySqlDialect().sqlToQuery(
			capturedWhere as Parameters<MySqlDialect['sqlToQuery']>[0],
		)
		expect(rendered.sql).toContain('`status` in')
		expect(rendered.params).toEqual(
			expect.arrayContaining([
				'kit',
				'send-value-path-email',
				'pending',
				'failed',
			]),
		)
	})
})
