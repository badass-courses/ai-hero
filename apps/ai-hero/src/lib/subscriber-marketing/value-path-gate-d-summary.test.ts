import { queryLearnerFlowCohortMembership } from './learner-flow-cohort'
import { contactEvent, sideEffectIntent } from '@/db/schema'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import type { SQL } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
	DrizzleCaptureMarketingRepository,
	LEARNER_FLOW_RECORD_PAGE_SIZE,
	decodeGateDStatusMetadata,
} from './drizzle-capture-repository'
import {
	summarizeGateDStatus,
	type GateDStatusIntent,
	type GateDStatusEvent,
} from './value-path-gate-d-summary'
import { evaluateValuePathMovement } from './value-path-run-state'

const now = '2026-09-01T00:00:00.000Z'
function intent(
	id: string,
	status: string,
	metadata: Record<string, unknown> = {},
): GateDStatusIntent {
	return {
		id,
		contactId: 'a',
		status,
		metadata,
		reviewReasons: [],
		createdAt: new Date('2026-08-01T00:00:00.000Z'),
	}
}

it('retains every status field across page boundaries and arbitrary event types', async () => {
	const intents = [
		{
			...intent('a', 'blocked', {
				emailResourceId: 'step-0',
				kitSequenceId: '1',
			}),
			reviewReasons: ['config-missing'],
		},
		intent('b', 'failed', {
			emailResourceId: 'step-1',
			kitSequenceId: '2',
			retryable: true,
			nextRetryAt: '2026-09-02',
		}),
		intent('c', 'failed', { retryable: true }),
		{ ...intent('d', 'failed'), reviewReasons: ['permanent'] },
		intent('e', 'pending'),
		{
			...intent('f', 'stale', {
				emailResourceId: 'ai-hero-skills-workflow.email-7',
				kitSequenceId: '7',
				completedAt: '2026-08-30T00:00:00.000Z',
			}),
			contactId: 'b',
		},
	]
	const events: GateDStatusEvent[] = [
		{
			contactId: 'a',
			eventType: 'value-path.answer-selected',
			occurredAt: now,
		},
		{
			contactId: 'a',
			eventType: 'value-path.drip-progressed',
			occurredAt: now,
		},
		{
			contactId: 'b',
			eventType: 'unrelated-but-reported',
			occurredAt: '2026-09-05',
		},
	]
	const summary = await summarizeGateDStatus({
		contactIds: ['a', 'b'],
		now,
		repository: {
			async *findGateDStatusPages() {
				for (const row of intents) yield { intents: [row], events: [] }
				for (const row of events) yield { intents: [], events: [row] }
			},
		},
	})
	expect(summary).toEqual({
		byContact: [
			{
				contactId: 'a',
				completedPath: false,
				lastEmailResourceId: undefined,
				lastKitSequenceId: undefined,
				lastStatus: 'pending',
				answerClicks: 1,
				drips: 1,
				blocked: [
					{
						intentId: 'a',
						emailResourceId: 'step-0',
						kitSequenceId: '1',
						reviewReasons: ['config-missing'],
					},
				],
			},
			{
				contactId: 'b',
				completedPath: true,
				lastEmailResourceId: 'ai-hero-skills-workflow.email-7',
				lastKitSequenceId: '7',
				lastStatus: 'stale',
				answerClicks: 0,
				drips: 0,
				blocked: [],
			},
		],
		grouped: {
			'blocked:step-0:1': 1,
			'failed:step-1:2': 1,
			'failed:undefined:undefined': 2,
			'pending:undefined:undefined': 1,
			'completed:ai-hero-skills-workflow.email-7:7': 1,
		},
		eventTypes: {
			'value-path.answer-selected': 1,
			'value-path.drip-progressed': 1,
			'unrelated-but-reported': 1,
		},
		totals: {
			contacts: 2,
			intents: 6,
			pending: 1,
			completed: 1,
			blocked: 1,
			stale: 1,
		},
		retrying: {
			retryableDue: 1,
			retryableWaiting: 1,
			nextRetryAt: '2026-09-02',
			hardFailed: 1,
			hardFailedReasons: { permanent: 1 },
		},
		persistedBlockedReasons: { 'config-missing': 1 },
		currentStepDistribution: { none: 1, 'ai-hero-skills-workflow.email-7': 1 },
		completedPathCount: 1,
		movement: evaluateValuePathMovement({
			intents,
			events,
			participants: 2,
			completedPathCount: 1,
			now,
		}),
	})
})

it('reports an empty cohort without inventing movement', async () => {
	const summary = await summarizeGateDStatus({
		contactIds: [],
		now,
		repository: { async *findGateDStatusPages() {} },
	})
	expect(summary.totals.intents).toBe(0)
	expect(summary.byContact).toEqual([])
	expect(summary.movement.lastMovementAt).toBeUndefined()
})

describe('status query payload contract', () => {
	it('projects metadata without truncation or conflating null with missing', () => {
		const long = 'x'.repeat(100_001)
		expect(
			decodeGateDStatusMetadata(
				JSON.stringify({
					values: {
						emailResourceId: long,
						kitSequenceId: null,
						completedAt: null,
						retryable: true,
					},
					present: {
						emailResourceId: 1,
						kitSequenceId: 1,
						completedAt: 0,
						retryable: 1,
					},
				}),
			),
		).toEqual({ emailResourceId: long, kitSequenceId: null, retryable: true })
		expect(() => decodeGateDStatusMetadata('invalid')).toThrow()
	})
	it('streams >100k events with bounded projections, complete counters and one visit per row', async () => {
		const dialect = new MySqlDialect()
		const calls: Array<{
			table: unknown
			selection: Record<string, unknown>
			limit: number
			params: unknown[]
		}> = []
		let returned = 0
		let largestPayload = 0
		const count = 100_003
		const database = {
			select: (selection: Record<string, unknown>) => ({
				from: (table: unknown) => ({
					where: (condition: SQL) => ({
						orderBy: () => ({
							limit: (limit: number) => {
								const query = dialect.sqlToQuery(condition)
								calls.push({ table, selection, limit, params: query.params })
								if (table === sideEffectIntent) return []
								const rows = Array.from(
									{ length: Math.min(limit, count - returned) },
									(_, index) => ({
										id: `event-${String(returned + index).padStart(6, '0')}`,
										contactId: 'a',
										eventType:
											(returned + index) % 2
												? 'value-path.answer-selected'
												: 'other',
										occurredAt: now,
									}),
								)
								returned += rows.length
								largestPayload = Math.max(
									largestPayload,
									Buffer.byteLength(JSON.stringify(rows)),
								)
								return rows
							},
						}),
					}),
				}),
			}),
		}
		const summary = await summarizeGateDStatus({
			repository: new DrizzleCaptureMarketingRepository(database),
			contactIds: ['a'],
			now,
		})
		expect(returned).toBe(count)
		expect(summary.eventTypes).toEqual({
			other: 50_002,
			'value-path.answer-selected': 50_001,
		})
		expect(summary.byContact[0]?.answerClicks).toBe(50_001)
		const eventCalls = calls.filter((call) => call.table === contactEvent)
		expect(eventCalls).toHaveLength(21)
		expect(eventCalls.every((call) => call.limit === 5000)).toBe(true)
		expect(
			eventCalls.every(
				(call) =>
					Object.keys(call.selection).sort().join(',') ===
					'contactId,eventType,id,occurredAt',
			),
		).toBe(true)
		expect(eventCalls[1]?.params).toContain('event-004999')
		expect(largestPayload).toBeLessThan(1_000_000)
	})

	it('bounds all status contact IN lists and does not filter away other event types or providers', async () => {
		const dialect = new MySqlDialect()
		const queries: Array<{ sql: string; params: unknown[] }> = []
		const database = {
			select: () => ({
				from: () => ({
					where: (condition: SQL) => ({
						orderBy: () => ({
							limit: () => {
								queries.push(dialect.sqlToQuery(condition))
								return []
							},
						}),
					}),
				}),
			}),
		}
		const repository = new DrizzleCaptureMarketingRepository(database)
		const ids = Array.from(
			{ length: LEARNER_FLOW_RECORD_PAGE_SIZE * 2 + 1 },
			(_, i) => `c-${i}`,
		)
		for await (const _page of repository.findGateDStatusPages(ids)) {
			/* exhaust */
		}
		expect(queries).toHaveLength(6)
		for (const query of queries) {
			expect(
				query.params.filter(
					(value) => typeof value === 'string' && value.startsWith('c-'),
				).length,
			).toBeLessThanOrEqual(LEARNER_FLOW_RECORD_PAGE_SIZE)
			expect(query.sql).not.toContain('`provider`')
			expect(query.sql).not.toContain('`eventType`')
		}
	})
})

it('uses live membership for rolling and intersects live membership for finish-approved-path', async () => {
	const repository = {
		findSkillsWorkflowLearnerFlowMembership: async () => [
			'live-new',
			'approved-live',
		],
	}
	const contactIds = ['approved-live', 'approved-absent']
	expect(
		await queryLearnerFlowCohortMembership({
			repository,
			allowlist: { authorizationMode: 'rolling-public-enrollment', contactIds },
		}),
	).toEqual({
		source: 'live-rolling-learner-flow',
		contactIds: ['live-new', 'approved-live'],
		liveRecordsScanned: 2,
	})
	expect(
		await queryLearnerFlowCohortMembership({
			repository,
			allowlist: { authorizationMode: 'finish-approved-path', contactIds },
		}),
	).toEqual({
		source: 'live-finish-approved-path',
		contactIds: ['approved-live'],
		liveRecordsScanned: 2,
	})
})
