import {
	contact,
	contactEvent,
	contactState,
	sideEffectIntent,
} from '@/db/schema'
import type { SQL } from 'drizzle-orm'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { expect, it } from 'vitest'
import {
	DrizzleCaptureMarketingRepository,
	LEARNER_FLOW_RECORD_PAGE_SIZE,
} from './drizzle-capture-repository'

it('bounds repair hydration and retains full entry evidence across row pages', async () => {
	const dialect = new MySqlDialect()
	const ids = Array.from(
		{ length: LEARNER_FLOW_RECORD_PAGE_SIZE + 1 },
		(_, i) => `c-${String(i).padStart(5, '0')}`,
	)
	let idOffset = 0
	const calls: Array<{
		table: unknown
		params: unknown[]
		limit?: number
		selection: unknown
	}> = []
	const database = {
		selectDistinct: () => ({
			from: () => ({
				where: () => ({
					union: () => ({
						as: () => ({ contactId: sideEffectIntent.contactId }),
					}),
				}),
			}),
		}),
		select: (selection?: unknown) => ({
			from: (table: unknown) => ({
				where: (condition?: SQL) => {
					const params = condition ? dialect.sqlToQuery(condition).params : []
					if (table === contact || table === contactState) {
						calls.push({ table, params, selection })
						return []
					}
					return {
						orderBy: () => ({
							limit: (limit: number) => {
								calls.push({ table, params, limit, selection })
								if (table !== sideEffectIntent && table !== contactEvent) {
									const page = ids
										.slice(idOffset, idOffset + limit)
										.map((contactId) => ({ contactId }))
									idOffset += page.length
									return page
								}
								if (table === sideEffectIntent) return []
								const contactId = params.find(
									(value) =>
										typeof value === 'string' && value.startsWith('c-'),
								)
								const continued = params.some(
									(value) =>
										typeof value === 'string' && value.startsWith('event-'),
								)
								return Array.from(
									{ length: continued ? 1 : limit },
									(_, index) => ({
										id: `event-${String(continued ? limit : index).padStart(6, '0')}`,
										contactId,
										eventType: 'value-path.entered',
										providerReference: 'value-path:ai-hero-skills-workflow',
										occurredAt: '2026-08-01T00:00:00.000Z',
										createdAt: '2026-08-01T00:00:00.000Z',
										payloadSummary: {
											evidence: 'must survive repair projection',
										},
									}),
								)
							},
						}),
					}
				},
			}),
		}),
	}
	const repository = new DrizzleCaptureMarketingRepository(database)
	const pages = []
	for await (const page of repository.findSkillsWorkflowLearnerFlowRepairRecordPages(
		{ includeCanary: true },
	))
		pages.push(page)
	expect(pages).toHaveLength(2)
	expect(pages.map((page) => page[0]?.entryEvents.length)).toEqual([5001, 5001])
	expect(pages[0]?.[0]?.entryEvents[5000]?.payloadSummary).toEqual({
		evidence: 'must survive repair projection',
	})
	for (const call of calls) {
		if (
			call.table === contact ||
			call.table === contactState ||
			call.table === contactEvent ||
			call.table === sideEffectIntent
		) {
			expect(
				call.params.filter(
					(value) => typeof value === 'string' && value.startsWith('c-'),
				).length,
			).toBeLessThanOrEqual(LEARNER_FLOW_RECORD_PAGE_SIZE)
			expect(call.selection).toBeUndefined()
		}
		if (call.table === contactEvent || call.table === sideEffectIntent)
			expect(call.limit).toBe(5000)
	}
})
