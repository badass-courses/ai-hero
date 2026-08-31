import { describe, expect, it, vi } from 'vitest'
import { courseSequenceContactEvent } from '@/db/course-sequence-exhaustion-schema'
import { nextAction, sideEffectIntent } from '@/db/schema'

import { parseIsoInstant } from './evergreen-offer-journey/primitives'
import {
	COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
	deadlineTimeZoneEvidenceFromHeader,
	type CourseSequenceExhaustionCommitRequest,
} from './course-sequence-exhaustion'
import { DrizzleCaptureMarketingRepository } from './drizzle-capture-repository'
import type { NextAction, SideEffectIntent } from './types'

function primaryDuplicate() {
	return Object.assign(new Error("Duplicate entry 'abc12' for key 'PRIMARY'"), {
		code: 'ER_DUP_ENTRY',
		errno: 1062,
	})
}

function plannedRecords(attempt: number): {
	nextAction: NextAction
	sideEffectIntents: SideEffectIntent[]
} {
	const nextActionId = `next-action-${attempt}`
	return {
		nextAction: {
			id: nextActionId,
			contactId: 'contact-1',
			contactStateId: 'state-1',
			eventId: 'event-1',
			type: 'enter-value-path',
			status: 'planned',
			gates: [],
			reviewReasons: [],
			rationale: [],
			createdAt: '2026-08-09T00:00:00.000Z',
		},
		sideEffectIntents: [
			{
				id: `intent-${attempt}`,
				nextActionId,
				contactId: 'contact-1',
				provider: 'dry-run',
				type: 'preview-shadow-field-sync',
				status: 'dry-run',
				idempotencyKey: 'gate-b:event-1:enter-value-path',
				gates: [],
				reviewReasons: [],
				metadata: {},
				createdAt: '2026-08-09T00:00:00.000Z',
			},
		],
	}
}

function sequenceExhaustionRequest(): CourseSequenceExhaustionCommitRequest {
	const deadline = deadlineTimeZoneEvidenceFromHeader({
		headerValue: 'Asia/Tokyo',
		capturedAt: '2026-08-01T00:00:00.000Z',
	})
	if (!deadline.ok) throw new Error(deadline.error.detail)
	return {
		sourceIntentId: 'email-6-intent',
		courseEntryEventId: 'course-entry',
		records: {
			fact: {
				id: 'sequence-fact',
				contactId: 'contact-1',
				providerIdentityId: 'identity-1',
				provider: 'ai-hero',
				providerEventId:
					'email-course.sequence-exhausted:contact-1:ai-hero-skills-workflow',
				providerReference: 'value-path:ai-hero-skills-workflow',
				eventType: 'course.sequence-exhausted',
				occurredAt: '2026-08-03T00:00:00.000Z',
				semanticIdempotencyKey:
					'email-course.sequence-exhausted:contact-1:ai-hero-skills-workflow',
				domainFactKey:
					'email-course.sequence-exhausted:contact-1:ai-hero-skills-workflow',
				payloadFormat: COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
				domainPayload: {
					format: COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
					actor: {
						actorId:
							'email-course:contact-1:ai-hero-skills-workflow',
						contactId: 'contact-1',
						valuePathId: 'ai-hero-skills-workflow',
						courseEntryEventId: 'course-entry',
					},
					exhaustedAt: instant('2026-08-03T00:00:00.000Z'),
					deadlineTimeZone: deadline.value,
					progression: {
						from: {
							intentId: 'email-6-intent',
							idempotencyKey: 'email-6-key',
							emailResourceId:
								'ai-hero-skills-workflow.email-6',
							completedAt: instant('2026-08-01T00:00:00.000Z'),
						},
						trigger: {
							type: 'DailyDripDue',
							evaluatedAt: instant('2026-08-03T00:00:00.000Z'),
							reason: 'local-day-9am-due',
						},
						terminal: {
							intentId: 'email-7-intent',
							idempotencyKey: 'email-7-key',
							nextActionId: 'email-7-action',
							emailResourceId:
								'ai-hero-skills-workflow.email-7',
						},
					},
					sourceReferences: {
						courseEntryEventId: 'course-entry',
						priorIntentId: 'email-6-intent',
					},
				},
				privacyLevel: 'internal',
				identityEvidence: { source: 'ai-hero', strength: 'strong' },
				payloadSummary: {
					summary: 'Sequence exhausted',
					keywords: ['sequence-exhausted'],
					restrictedPayloadStored: false,
				},
				schemaVersion: 1,
				createdAt: '2026-08-03T00:00:00.000Z',
			},
			nextAction: {
				id: 'email-7-action',
				contactId: 'contact-1',
				contactStateId: 'state-1',
				eventId: 'sequence-fact',
				type: 'advance-value-path',
				status: 'planned',
				gates: [],
				reviewReasons: [],
				rationale: [],
				createdAt: '2026-08-03T00:00:00.000Z',
			},
			terminalIntent: {
				id: 'email-7-intent',
				nextActionId: 'email-7-action',
				contactId: 'contact-1',
				provider: 'kit',
				type: 'send-value-path-email',
				status: 'pending',
				completedAt: null,
				idempotencyKey: 'email-7-key',
				gates: [],
				reviewReasons: [],
				metadata: {
					valuePathSlug: 'ai-hero-skills-workflow',
					emailResourceId: 'ai-hero-skills-workflow.email-7',
					sequenceExhaustionFactId: 'sequence-fact',
				},
				createdAt: '2026-08-03T00:00:00.000Z',
			},
		},
	}
}

function instant(value: string) {
	const parsed = parseIsoInstant(value)
	if (!parsed.ok) throw new Error(parsed.error.reason)
	return parsed.value
}

function sequenceDatabase(
	failInsert?: number,
	request = sequenceExhaustionRequest(),
) {
	const sourceRow = {
		...request.records.terminalIntent,
		id: 'email-6-intent',
		idempotencyKey: 'email-6-key',
		status: 'completed',
		completedAt: new Date('2026-08-01T00:00:00.000Z'),
		metadata: {
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-6',
		},
	}
	const entryPayload = {
		format: 'email-course.entry.v1',
		valuePathId: 'ai-hero-skills-workflow',
		emailResourceId: 'ai-hero-skills-workflow.email-0',
		deadlineTimeZone: request.records.fact.domainPayload.deadlineTimeZone,
	}
	const entryRow = {
		...request.records.fact,
		id: 'course-entry',
		eventType: 'value-path.entered',
		domainFactKey: null,
		payloadFormat: 'email-course.entry.v1',
		domainPayload: entryPayload,
		payloadSummary: {
			...request.records.fact.payloadSummary,
			coursePayload: {
				format: 'email-course.entry.v1',
				payload: entryPayload,
			},
		},
	}
	const queues = new Map<unknown, unknown[][]>([
		[sideEffectIntent, [[sourceRow], []]],
		[courseSequenceContactEvent, [[entryRow], []]],
		[nextAction, []],
	])
	const select = () => ({
		from: (table: unknown) => ({
			where: () => ({
				limit: async () => queues.get(table)?.shift() ?? [],
			}),
		}),
	})
	const committed: Array<{ table: unknown; value: unknown }> = []
	const database = {
		select,
		transaction: vi.fn(async (write: (tx: unknown) => Promise<unknown>) => {
			const pending: Array<{ table: unknown; value: unknown }> = []
			let insert = 0
			const tx = {
				select,
				insert: (table: unknown) => ({
					values: async (value: unknown) => {
						insert++
						pending.push({ table, value })
						if (insert === failInsert) throw new Error('injected insert failure')
					},
				}),
			}
			const result = await write(tx)
			committed.push(...pending)
			return result
		}),
	}
	return { committed, database, request }
}

describe('DrizzleCaptureMarketingRepository collision handling', () => {
	it('commits sequence exhaustion, action, and terminal intent in one transaction', async () => {
		const { committed, database, request } = sequenceDatabase()
		const repository = new DrizzleCaptureMarketingRepository(database)

		await expect(
			repository.commitCourseSequenceExhaustion(request),
		).resolves.toMatchObject({ status: 'committed' })
		expect(database.transaction).toHaveBeenCalledTimes(1)
		expect(committed.map((row) => row.table)).toEqual([
			courseSequenceContactEvent,
			nextAction,
			sideEffectIntent,
		])
		expect(committed[0]?.value).toMatchObject({
			semanticIdempotencyKey:
				'email-course.sequence-exhausted:contact-1:ai-hero-skills-workflow',
			payloadSummary: {
				coursePayload: {
					format: 'email-course.sequence-exhausted.v1',
				},
			},
		})
		expect(committed[0]?.value).not.toHaveProperty('domainFactKey')
		expect(committed[0]?.value).not.toHaveProperty('domainPayload')
	})

	it('rejects a payload that names a different source intent', async () => {
		const base = sequenceExhaustionRequest()
		const request: CourseSequenceExhaustionCommitRequest = {
			...base,
			records: {
				...base.records,
				fact: {
					...base.records.fact,
					domainPayload: {
						...base.records.fact.domainPayload,
						progression: {
							...base.records.fact.domainPayload.progression,
							from: {
								...base.records.fact.domainPayload.progression.from,
								intentId: 'bogus-source',
							},
						},
						sourceReferences: {
							...base.records.fact.domainPayload.sourceReferences,
							priorIntentId: 'bogus-source',
						},
					},
				},
			},
		}
		const { committed, database } = sequenceDatabase(undefined, request)
		const repository = new DrizzleCaptureMarketingRepository(database)

		await expect(
			repository.commitCourseSequenceExhaustion(request),
		).rejects.toThrow('does not own the commit')
		expect(committed).toEqual([])
	})

	it('rejects a payload that names another terminal action', async () => {
		const base = sequenceExhaustionRequest()
		const request: CourseSequenceExhaustionCommitRequest = {
			...base,
			records: {
				...base.records,
				fact: {
					...base.records.fact,
					domainPayload: {
						...base.records.fact.domainPayload,
						progression: {
							...base.records.fact.domainPayload.progression,
							terminal: {
								...base.records.fact.domainPayload.progression.terminal,
								nextActionId: 'bogus-action',
							},
						},
					},
				},
			},
		}
		const { committed, database } = sequenceDatabase(undefined, request)
		const repository = new DrizzleCaptureMarketingRepository(database)

		await expect(
			repository.commitCourseSequenceExhaustion(request),
		).rejects.toThrow('does not own the commit')
		expect(committed).toEqual([])
	})

	it.each([1, 2, 3])(
		'rolls back every row when insert %s fails',
		async (failInsert) => {
			const { committed, database, request } = sequenceDatabase(failInsert)
			const repository = new DrizzleCaptureMarketingRepository(database)

			await expect(
				repository.commitCourseSequenceExhaustion(request),
			).rejects.toThrow('injected insert failure')
			expect(committed).toEqual([])
		},
	)

	it('retries linked records as one transaction with consistent references', async () => {
		let transactionAttempt = 0
		const committedRows: unknown[][] = []
		const database = {
			transaction: vi.fn(async (write: (tx: unknown) => Promise<void>) => {
				transactionAttempt++
				const rows: unknown[] = []
				let insertNumber = 0
				const tx = {
					insert: vi.fn(() => ({
						values: async (value: unknown) => {
							insertNumber++
							rows.push(value)
							if (
								(transactionAttempt === 1 && insertNumber === 1) ||
								(transactionAttempt === 2 && insertNumber === 2)
							) {
								throw primaryDuplicate()
							}
						},
					})),
				}
				await write(tx)
				committedRows.push(rows)
			}),
		}
		const repository = new DrizzleCaptureMarketingRepository(database)
		let plannedAttempt = 0

		const result = await repository.createNextActionWithSideEffectIntents(() =>
			plannedRecords(++plannedAttempt),
		)

		expect(database.transaction).toHaveBeenCalledTimes(3)
		expect(result.nextAction.id).toBe('next-action-3')
		expect(result.sideEffectIntents[0]?.nextActionId).toBe(result.nextAction.id)
		expect(committedRows).toHaveLength(1)
		expect(committedRows[0]).toEqual([
			expect.objectContaining({ id: 'next-action-3' }),
			expect.objectContaining({
				id: 'intent-3',
				nextActionId: 'next-action-3',
			}),
		])
	})

	it('keeps old five-character stored IDs readable', async () => {
		const database = {
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async () => [
							{
								id: 'a1b2c',
								nextActionId: 'c3d4e',
								contactId: 'contact-1',
								provider: 'kit',
								type: 'send-value-path-email',
								status: 'pending',
								completedAt: null,
								idempotencyKey: 'contact:1:path:email:0',
								gates: [],
								reviewReasons: [],
								metadata: {},
								createdAt: new Date('2026-08-01T00:00:00.000Z'),
							},
						],
					}),
				}),
			}),
		}
		const repository = new DrizzleCaptureMarketingRepository(database)

		await expect(
			repository.findSideEffectIntentByIdempotencyKey('contact:1:path:email:0'),
		).resolves.toMatchObject({
			id: 'a1b2c',
			nextActionId: 'c3d4e',
		})
	})
})
