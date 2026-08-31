import { createHash } from 'node:crypto'

import * as databaseSchema from '@/db/schema'
import { contactEvent, emailCourseCommit, sideEffectIntent } from '@/db/schema'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import { Effect } from 'effect'
import type { FieldPacket, ResultSetHeader } from 'mysql2/promise'
import { z } from 'zod'

import { isMysqlDuplicateEntryError } from '../mysql-primary-key-retry'
import {
	COURSE_SEQUENCE_EXHAUSTED_EVENT_TYPE,
	COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
	courseSequenceExhaustionFactKey,
	restoreDeadlineTimeZoneEvidence,
	restoreCourseSequenceExhaustedPayload,
	withCoursePayload,
} from './course-sequence-exhaustion'
import type {
	CourseEmailIntent,
	EmailCourseDomainEvent,
	EmailCourseOutboxChange,
	EmailCoursePlanningState,
	EmailCourseRun,
} from './email-course/domain'
import {
	restoreCourseEmailIntent,
	restoreEmailCourseDecision,
	restoreEmailCourseRun,
} from './email-course/restoration'
import type {
	AdvanceEmailCourseResult,
	EmailCourseCommandError,
	EmailCourseCommit,
	EmailCourseLedger,
} from './email-course/ports'
import type { EmailCourseDefinition } from './email-course/definition'
import type { CourseRunId, IntentId } from './email-course/primitives'

const COMMIT_RECEIPT_FORMAT = 'email-course.advance-result.v1' as const
const OUTBOX_PAYLOAD_FORMAT = 'email-course.intent.v1' as const
const OUTBOX_PROVIDER = 'email-course' as const
const OUTBOX_TYPE = 'send-course-email' as const

export type EmailCourseDatabase = MySql2Database<typeof databaseSchema>
type EmailCourseTransaction = Parameters<
	Parameters<EmailCourseDatabase['transaction']>[0]
>[0]
type EmailCourseQueryExecutor = EmailCourseDatabase | EmailCourseTransaction
type CommitRow = typeof emailCourseCommit.$inferSelect
type OutboxRow = typeof sideEffectIntent.$inferSelect
type WriteReceipt = ResultSetHeader | [ResultSetHeader, FieldPacket[]]

const OutboxPayloadSchema = z
	.object({
		format: z.literal(OUTBOX_PAYLOAD_FORMAT),
		intent: z.unknown(),
	})
	.strict()
const TransactionRaceErrorSchema = z
	.object({
		code: z.string().optional(),
		errno: z.number().optional(),
		sqlState: z.string().optional(),
	})
	.passthrough()

class EmailCourseLedgerAbort extends Error {
	constructor(readonly error: EmailCourseCommandError) {
		super(error.type)
	}
}

export function createDrizzleEmailCourseLedger(
	database: EmailCourseDatabase,
	definition: EmailCourseDefinition,
): EmailCourseLedger {
	const load: EmailCourseLedger['load'] = (runId) =>
		Effect.tryPromise({
			try: () => loadState(database, definition, runId),
			catch: commandError,
		})

	const findCommittedStimulus: EmailCourseLedger['findCommittedStimulus'] = (
		stimulusId,
	) =>
		Effect.tryPromise({
			try: async () => {
				const row = await database.query.emailCourseCommit.findFirst({
					where: eq(emailCourseCommit.stimulusId, stimulusId),
				})
				return row ? replayed(readCommittedDecision(row, definition)) : null
			},
			catch: commandError,
		})

	const commit: EmailCourseLedger['commit'] = (input) =>
		Effect.tryPromise({
			try: async () => {
				const candidate = structuredClone(input)
				for (let attempt = 0; attempt < 3; attempt += 1) {
					try {
						return await database.transaction((transaction) =>
							commitInTransaction(transaction, definition, candidate),
						)
					} catch (cause) {
						const existing = await database.query.emailCourseCommit.findFirst({
							where: eq(
								emailCourseCommit.stimulusId,
								candidate.stimulus.stimulusId,
							),
						})
						if (existing) {
							return replayed(readCommittedDecision(existing, definition))
						}
						if (isRetryableTransactionRace(cause) && attempt < 2) continue
						throw cause
					}
				}
				throw new EmailCourseLedgerAbort({
					type: 'CoursePersistenceUnavailable',
					reason: 'Transaction retry budget exhausted',
				})
			},
			catch: commandError,
		})

	const inspectRun: EmailCourseLedger['inspectRun'] = (runId) =>
		Effect.fail({
			type: 'CourseInspectionUnavailable',
			reason: `Run inspection is wired in slice 5: ${runId}`,
		})

	return { load, findCommittedStimulus, commit, inspectRun }
}

async function commitInTransaction(
	transaction: EmailCourseTransaction,
	definition: EmailCourseDefinition,
	candidate: EmailCourseCommit,
): Promise<AdvanceEmailCourseResult> {
	const runId = candidate.decision.next.runId
	// Lock before any consistent read. A pre-lock read would pin a stale
	// REPEATABLE READ snapshot and let a waiting race miss the winning commit.
	await transaction.execute(
		sql`SELECT ${emailCourseCommit.runId}, ${emailCourseCommit.actorVersion} FROM ${emailCourseCommit} WHERE ${emailCourseCommit.runId} = ${runId} ORDER BY ${emailCourseCommit.actorVersion} DESC LIMIT 1 FOR UPDATE`,
	)
	const existing = await transaction.query.emailCourseCommit.findFirst({
		where: eq(emailCourseCommit.stimulusId, candidate.stimulus.stimulusId),
	})
	if (existing) return replayed(readCommittedDecision(existing, definition))

	const head = await transaction.query.emailCourseCommit.findFirst({
		where: eq(emailCourseCommit.runId, runId),
		orderBy: [desc(emailCourseCommit.actorVersion)],
	})
	const currentVersion = head?.actorVersion ?? null
	if (currentVersion !== candidate.expectedVersion) {
		throw new EmailCourseLedgerAbort({
			type: 'CourseRunVersionConflict',
			runId,
		})
	}
	if (
		candidate.decision.next.actorVersion !==
		(candidate.expectedVersion ?? 0) + 1
	) {
		throw constraint(candidate, 'Actor version is not the next version')
	}

	const current = head ? await loadState(transaction, definition, runId) : null
	if (!jsonDeepEqual(current, candidate.previous)) {
		throw new EmailCourseLedgerAbort({
			type: 'CourseRunVersionConflict',
			runId,
		})
	}

	for (const change of candidate.decision.outboxChanges) {
		await applyOutboxChange(transaction, candidate, change)
	}
	await commitSequenceExhaustionFact(transaction, candidate)

	const result: AdvanceEmailCourseResult = {
		decision: candidate.decision,
		committed: true,
		replayedStimulus: false,
	}
	await transaction.insert(emailCourseCommit).values({
		runId,
		actorVersion: candidate.decision.next.actorVersion,
		stimulusId: candidate.stimulus.stimulusId,
		snapshot: candidate.decision.next,
		decision: candidate.decision,
		events: candidate.decision.events,
		receipt: { format: COMMIT_RECEIPT_FORMAT, result },
		decidedAt: new Date(candidate.decidedAt),
		committedAt: new Date(candidate.decidedAt),
	})
	return result
}

async function applyOutboxChange(
	transaction: EmailCourseTransaction,
	candidate: EmailCourseCommit,
	change: EmailCourseOutboxChange,
): Promise<void> {
	switch (change.type) {
		case 'Plan':
			await insertIntent(transaction, change.intent, candidate.decidedAt)
			return
		case 'ReplaceRoute': {
			await requireSingleWrite(
				transaction
					.update(sideEffectIntent)
					.set({
						status: 'superseded',
						activeSlot: null,
						availableAt: null,
						reviewReasons: ['answer-selected-route-change'],
					})
					.where(
						and(
							eq(sideEffectIntent.id, change.expectedIntentId),
							eq(sideEffectIntent.courseRunId, candidate.decision.next.runId),
							eq(sideEffectIntent.activeSlot, 'next'),
						),
					),
				candidate,
				'Expected route intent was not active',
			)
			await insertIntent(transaction, change.replacement, candidate.decidedAt)
			return
		}
		case 'Accelerate':
		case 'ScheduleRetry':
		case 'Hold':
		case 'Settle':
			await requireSingleWrite(
				transaction
					.update(sideEffectIntent)
					.set(outboxUpdate(change.intent))
					.where(
						and(
							eq(sideEffectIntent.id, change.intent.id),
							eq(sideEffectIntent.courseRunId, change.intent.runId),
						),
					),
				candidate,
				`Intent ${change.intent.id} was not available for ${change.type}`,
			)
			return
	}
}

async function insertIntent(
	transaction: EmailCourseTransaction,
	intent: Extract<CourseEmailIntent, { status: 'Pending' }>,
	createdAt: string,
): Promise<void> {
	await transaction.insert(sideEffectIntent).values({
		id: intent.id,
		nextActionId: nextActionId(intent.runId),
		contactId: intent.contactId,
		provider: OUTBOX_PROVIDER,
		type: OUTBOX_TYPE,
		status: 'pending',
		completedAt: null,
		courseRunId: intent.runId,
		availableAt: new Date(intent.availableAt),
		activeSlot: intent.activeSlot,
		idempotencyKey: intent.idempotencyKey,
		gates: [],
		reviewReasons: [],
		metadata: { format: OUTBOX_PAYLOAD_FORMAT, intent },
		createdAt: new Date(createdAt),
	})
}

function outboxUpdate(intent: CourseEmailIntent) {
	return {
		status: outboxStatus(intent),
		completedAt:
			intent.status === 'Settled' ? new Date(intent.settledAt) : null,
		availableAt:
			intent.status === 'Settled' ? null : new Date(intent.availableAt),
		activeSlot: intent.activeSlot,
		reviewReasons: outboxReviewReasons(intent),
		metadata: { format: OUTBOX_PAYLOAD_FORMAT, intent },
	}
}

function outboxStatus(intent: CourseEmailIntent): string {
	switch (intent.status) {
		case 'Pending':
			return 'pending'
		case 'RetryWaiting':
			return 'retry-waiting'
		case 'Held':
			return 'held'
		case 'Settled':
			return intent.outcome.type === 'Applied' ? 'completed' : 'refused'
	}
}

function outboxReviewReasons(intent: CourseEmailIntent): string[] {
	switch (intent.status) {
		case 'Pending':
			return []
		case 'RetryWaiting':
			return ['provider-retry-waiting']
		case 'Held':
			return [intent.reason]
		case 'Settled':
			return intent.outcome.type === 'Applied' ? [] : [intent.outcome.type]
	}
}

async function commitSequenceExhaustionFact(
	transaction: EmailCourseTransaction,
	candidate: EmailCourseCommit,
): Promise<void> {
	const exhaustion = candidate.decision.events.find(
		(
			event,
		): event is Extract<
			EmailCourseDomainEvent,
			{ type: 'CourseSequenceExhausted' }
		> => event.type === 'CourseSequenceExhausted',
	)
	if (!exhaustion) return
	const previousIntent = candidate.previous?.currentIntent
	const terminalPlan = candidate.decision.outboxChanges.find(
		(change) =>
			change.type === 'Plan' &&
			change.intent.id === exhaustion.terminalIntentId,
	)
	const stimulus = candidate.stimulus
	if (
		stimulus.type !== 'DeliverySettled' ||
		stimulus.outcome.type !== 'Applied' ||
		!previousIntent ||
		previousIntent.status === 'Settled' ||
		!terminalPlan ||
		terminalPlan.type !== 'Plan'
	) {
		throw constraint(candidate, 'Sequence exhaustion evidence is incomplete')
	}
	const source = await transaction.query.contactEvent.findFirst({
		where: eq(contactEvent.id, candidate.decision.next.entryEventId),
	})
	if (!source) {
		throw constraint(candidate, 'Course entry event is missing')
	}
	const deadlineTimeZone = restoreDeadlineTimeZoneEvidence(
		candidate.decision.next.scheduleEvidence,
	)
	if (!deadlineTimeZone) {
		throw constraint(candidate, 'Course deadline timezone is invalid')
	}
	const valuePathId = skillsWorkflowPathId(terminalPlan.intent.pathId)
	if (!valuePathId) {
		throw constraint(candidate, 'Sequence exhaustion path is invalid')
	}
	const payload = restoreCourseSequenceExhaustedPayload({
		format: COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
		actor: {
			actorId: `email-course:${candidate.decision.next.contactId}:${valuePathId}`,
			contactId: candidate.decision.next.contactId,
			valuePathId,
			courseEntryEventId: candidate.decision.next.entryEventId,
		},
		exhaustedAt:
			candidate.decision.next.phase === 'sequenceExhausted'
				? candidate.decision.next.exhaustedAt
				: candidate.decidedAt,
		deadlineTimeZone,
		progression: {
			from: {
				intentId: previousIntent.id,
				idempotencyKey: previousIntent.idempotencyKey,
				emailResourceId: previousIntent.contentResourceId,
				completedAt: stimulus.outcome.appliedAt,
			},
			trigger: {
				type: 'DeliverySettled',
				evaluatedAt: stimulus.occurredAt,
				plannedAvailableAt: terminalPlan.intent.availableAt,
				policy:
					candidate.decision.next.scheduleEvidence.type === 'ExplicitFallback'
						? 'ExplicitTwentyFourHourFallback'
						: 'EighteenHourFloorThenLocalNine',
			},
			terminal: {
				intentId: terminalPlan.intent.id,
				idempotencyKey: terminalPlan.intent.idempotencyKey,
				nextActionId: nextActionId(terminalPlan.intent.runId),
				emailResourceId: terminalPlan.intent.contentResourceId,
			},
		},
		sourceReferences: {
			courseEntryEventId: candidate.decision.next.entryEventId,
			priorIntentId: previousIntent.id,
		},
	})
	if (!payload) {
		throw constraint(candidate, 'Sequence exhaustion payload is invalid')
	}
	const semanticIdempotencyKey = courseSequenceExhaustionFactKey({
		contactId: candidate.decision.next.contactId,
		valuePathId,
	})
	await transaction.insert(contactEvent).values({
		id: exhaustion.factId,
		contactId: candidate.decision.next.contactId,
		providerIdentityId: source.providerIdentityId,
		provider: 'ai-hero',
		providerEventId: exhaustion.factId,
		providerReference: `email-course:${candidate.decision.next.runId}`,
		eventType: COURSE_SEQUENCE_EXHAUSTED_EVENT_TYPE,
		semanticIdempotencyKey,
		privacyLevel: 'internal',
		identityEvidence: source.identityEvidence,
		payloadSummary: withCoursePayload(
			{
				summary: 'Email Course sequence exhausted',
				keywords: ['email-course', 'sequence-exhausted', valuePathId],
				restrictedPayloadStored: false,
			},
			COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
			payload,
		),
		schemaVersion: 1,
		occurredAt: canonicalSecond(exhaustion.occurredAt),
		createdAt: canonicalSecond(candidate.decidedAt),
	})
}

async function loadState(
	database: EmailCourseQueryExecutor,
	definition: EmailCourseDefinition,
	runId: CourseRunId,
): Promise<EmailCoursePlanningState | null> {
	const head = await database.query.emailCourseCommit.findFirst({
		where: eq(emailCourseCommit.runId, runId),
		orderBy: [desc(emailCourseCommit.actorVersion)],
	})
	if (!head) return null
	const restoredRun = restoreEmailCourseRun(head.snapshot, definition)
	if (!restoredRun.ok) throw new EmailCourseLedgerAbort(restoredRun.error)
	const currentIntentId = activeIntentId(restoredRun.value)
	if (!currentIntentId) {
		return { run: restoredRun.value, currentIntent: null }
	}
	const row = await database.query.sideEffectIntent.findFirst({
		where: eq(sideEffectIntent.id, currentIntentId),
	})
	if (!row) {
		throw new EmailCourseLedgerAbort({
			type: 'CourseRunDecodeFailure',
			reason: `Current intent is missing: ${currentIntentId}`,
		})
	}
	return {
		run: restoredRun.value,
		currentIntent: restoreOutboxRow(row, definition),
	}
}

function readCommittedDecision(
	row: CommitRow,
	definition: EmailCourseDefinition,
): AdvanceEmailCourseResult {
	const decision = restoreEmailCourseDecision(row.decision, definition)
	if (!decision.ok) throw new EmailCourseLedgerAbort(decision.error)
	return {
		decision: decision.value,
		committed: true,
		replayedStimulus: false,
	}
}

function restoreOutboxRow(
	row: OutboxRow,
	definition: EmailCourseDefinition,
): CourseEmailIntent {
	const metadata = OutboxPayloadSchema.safeParse(row.metadata)
	if (!metadata.success) {
		throw new EmailCourseLedgerAbort({
			type: 'CourseRunDecodeFailure',
			reason: `Intent metadata format is invalid: ${row.id}`,
		})
	}
	const restored = restoreCourseEmailIntent(metadata.data.intent, definition)
	if (!restored.ok) throw new EmailCourseLedgerAbort(restored.error)
	if (
		restored.value.id !== row.id ||
		restored.value.runId !== row.courseRunId ||
		restored.value.idempotencyKey !== row.idempotencyKey ||
		restored.value.activeSlot !== row.activeSlot
	) {
		throw new EmailCourseLedgerAbort({
			type: 'CourseRunDecodeFailure',
			reason: `Intent row identity disagrees with its payload: ${row.id}`,
		})
	}
	return restored.value
}

function activeIntentId(run: EmailCourseRun): IntentId | null {
	switch (run.phase) {
		case 'active.awaitingDelivery':
		case 'active.awaitingNextDue':
		case 'active.retryWait':
			return run.activeIntentId
		case 'sequenceExhausted':
			return run.terminalIntentId
		case 'stopped':
			return null
	}
}

async function requireSingleWrite(
	write: PromiseLike<WriteReceipt>,
	candidate: EmailCourseCommit,
	reason: string,
): Promise<void> {
	const receipt = await write
	if (writtenRows(receipt) !== 1) throw constraint(candidate, reason)
}

function writtenRows(receipt: WriteReceipt): number {
	return Array.isArray(receipt) ? receipt[0].affectedRows : receipt.affectedRows
}

function nextActionId(runId: CourseRunId): string {
	return `email-course-action:${digest(runId)}`
}

function skillsWorkflowPathId(
	value: string,
): 'ai-hero-skills-workflow' | 'ai-hero-skills-team-workflow' | null {
	switch (value) {
		case 'ai-hero-skills-workflow':
		case 'ai-hero-skills-team-workflow':
			return value
		default:
			return null
	}
}

function canonicalSecond(value: string): Date {
	const date = new Date(value)
	date.setUTCMilliseconds(0)
	return date
}

function replayed(result: AdvanceEmailCourseResult): AdvanceEmailCourseResult {
	return { ...result, committed: false, replayedStimulus: true }
}

function constraint(
	candidate: EmailCourseCommit,
	reason: string,
): EmailCourseLedgerAbort {
	return new EmailCourseLedgerAbort({
		type: 'CourseRunConstraintViolation',
		runId: candidate.decision.next.runId,
		reason,
	})
}

function commandError(cause: unknown): EmailCourseCommandError {
	if (cause instanceof EmailCourseLedgerAbort) return cause.error
	if (isMysqlDuplicateEntryError(cause)) {
		return {
			type: 'CoursePersistenceUnavailable',
			reason: `Duplicate persistence identity: ${errorMessage(cause)}`,
		}
	}
	return {
		type: 'CoursePersistenceUnavailable',
		reason: errorMessage(cause),
	}
}

function isRetryableTransactionRace(cause: unknown): boolean {
	const parsed = TransactionRaceErrorSchema.safeParse(cause)
	if (!parsed.success) return false
	return (
		parsed.data.code === 'ER_LOCK_DEADLOCK' ||
		parsed.data.code === 'ER_LOCK_WAIT_TIMEOUT' ||
		parsed.data.errno === 1213 ||
		parsed.data.errno === 1205 ||
		parsed.data.sqlState === '40001'
	)
}

function jsonDeepEqual(
	left: EmailCoursePlanningState | null,
	right: EmailCoursePlanningState | null,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right)
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause)
}

function digest(value: string): string {
	return createHash('sha256').update(value).digest('hex').slice(0, 32)
}
