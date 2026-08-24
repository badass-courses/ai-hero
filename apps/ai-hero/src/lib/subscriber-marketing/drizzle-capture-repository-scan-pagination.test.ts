import { sideEffectIntent } from '@/db/schema'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { describe, expect, it } from 'vitest'

import { DrizzleCaptureMarketingRepository } from './drizzle-capture-repository'

const SCAN_PAGE_SIZE = 5000

const makeRow = (id: string) => ({
	id,
	nextActionId: null,
	contactId: 'contact-1',
	provider: 'kit',
	type: 'send-value-path-email',
	status: 'completed',
	completedAt: null,
	idempotencyKey: `key-${id}`,
	gates: null,
	reviewReasons: null,
	metadata: {},
	createdAt: '2026-08-12T00:00:00.000Z',
})

const makeDatabase = (pages: Array<Array<ReturnType<typeof makeRow>>>) => {
	const calls: Array<{ condition: unknown; limit: number }> = []
	const database = {
		select: () => ({
			from: () => ({
				where: (condition: unknown) => ({
					orderBy: () => ({
						limit: (limitValue: number) => {
							calls.push({ condition, limit: limitValue })
							return pages[calls.length - 1] ?? []
						},
					}),
				}),
			}),
		}),
	}
	return { database, calls }
}

describe('findValuePathEmailSideEffectIntentsForScan pagination', () => {
	it('pages by primary key so no single result can cross the vtgate response cap', async () => {
		const fullPage = Array.from({ length: SCAN_PAGE_SIZE }, (_, index) =>
			makeRow(`aaa-${String(index).padStart(6, '0')}`),
		)
		const lastPage = [makeRow('bbb-000000'), makeRow('bbb-000001')]
		const { database, calls } = makeDatabase([fullPage, lastPage])
		const repository = new DrizzleCaptureMarketingRepository(database)

		const records =
			await repository.findValuePathEmailSideEffectIntentsForScan()

		expect(records).toHaveLength(SCAN_PAGE_SIZE + 2)
		expect(records[0]?.id).toBe('aaa-000000')
		expect(records.at(-1)?.id).toBe('bbb-000001')
		expect(calls).toHaveLength(2)
		expect(calls.every((call) => call.limit === SCAN_PAGE_SIZE)).toBe(true)

		const secondWhere = new MySqlDialect().sqlToQuery(
			calls[1]?.condition as Parameters<MySqlDialect['sqlToQuery']>[0],
		)
		expect(secondWhere.sql).toContain('`id` >')
		expect(secondWhere.params).toEqual(
			expect.arrayContaining([
				'kit',
				'send-value-path-email',
				`aaa-${String(SCAN_PAGE_SIZE - 1).padStart(6, '0')}`,
			]),
		)
	})

	it('pages the learner-flow intent read and keeps the canary exclusion', async () => {
		const fullPage = Array.from({ length: SCAN_PAGE_SIZE }, (_, index) =>
			makeRow(`aaa-${String(index).padStart(6, '0')}`),
		)
		const intentPages = [fullPage, [makeRow('bbb-000000')]]
		const intentCalls: Array<{ condition: unknown }> = []
		const database = {
			select: () => ({
				from: (table: unknown) => {
					if (table === sideEffectIntent) {
						return {
							where: (condition: unknown) => ({
								orderBy: () => ({
									limit: () => {
										intentCalls.push({ condition })
										return intentPages[intentCalls.length - 1] ?? []
									},
								}),
							}),
						}
					}
					return { where: async () => [] }
				},
			}),
		}
		const repository = new DrizzleCaptureMarketingRepository(database)

		const records = await repository.findSkillsWorkflowLearnerFlowRecords()

		expect(Array.isArray(records)).toBe(true)
		expect(intentCalls).toHaveLength(2)
		const dialect = new MySqlDialect()
		for (const call of intentCalls) {
			const rendered = dialect.sqlToQuery(
				call.condition as Parameters<MySqlDialect['sqlToQuery']>[0],
			)
			expect(rendered.sql).toContain('NOT EXISTS')
		}
		const secondWhere = dialect.sqlToQuery(
			intentCalls[1]?.condition as Parameters<MySqlDialect['sqlToQuery']>[0],
		)
		expect(secondWhere.sql).toContain('`id` >')
	})

	it('stops after one query when the first page is short', async () => {
		const { database, calls } = makeDatabase([[makeRow('only-row')]])
		const repository = new DrizzleCaptureMarketingRepository(database)

		const records =
			await repository.findValuePathEmailSideEffectIntentsForScan()

		expect(records).toHaveLength(1)
		expect(records[0]?.id).toBe('only-row')
		expect(calls).toHaveLength(1)
	})
})
