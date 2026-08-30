/* oxlint-disable anti-slop(no-unknown-parameters), anti-slop(no-runtime-typeof), anti-slop(no-unsafe-dictionary-type), anti-slop(no-unknown-returns) -- Drizzle erasure and persisted JSON stay inside this adapter; domain values are decoded before return. */

import * as journeySchema from '@/db/evergreen-offer-journey-schema'
import {
	evergreenOfferJourneyCommit,
	evergreenOfferJourneyIntent,
	evergreenOfferJourneyWake,
} from '@/db/evergreen-offer-journey-schema'
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import { Effect } from 'effect'

import { isMysqlDuplicateEntryError } from '../../mysql-primary-key-retry'

import { decideEvergreenOfferJourney } from './decision'
import {
	EVERGREEN_OFFER_JOURNEY_COMMIT_FORMAT,
	EVERGREEN_OFFER_JOURNEY_INTENT_FORMAT,
	EVERGREEN_OFFER_JOURNEY_WAKE_FORMAT,
} from './persistence-contract'
import type {
	EvergreenOfferJourneyAggregate,
	JourneyDecision,
	JourneyDomainEvent,
	JourneyView,
	SideEffectIntent,
} from './domain'
import { inspectEvergreenOfferJourney } from './inspection'
import {
	journeyCommitEvidenceRecord,
	restorePersistedDomainEvents,
	restorePersistedScheduleWake,
	restorePersistedSideEffectIntent,
	restorePersistedTransitionReceipt,
	validatePersistedCommitEvidenceEnvelope,
	type JourneyCommitEvidence,
} from './persistence-codec'
import type {
	CommittedJourneyDecision,
	JourneyCommandError,
	JourneyLedger,
	JourneyLedgerCommit,
	JourneyQueryError,
} from './ports'
import {
	encodeEvergreenOfferJourneySnapshot,
	restoreEvergreenOfferJourneySnapshot,
} from './restoration'
import type { IntentKey, JourneyId } from './primitives'

export type DrizzleJourneyLedger = JourneyLedger
export type EvergreenOfferJourneyDatabase = MySql2Database<typeof journeySchema>

type JourneyCommitRow = typeof evergreenOfferJourneyCommit.$inferSelect
type JourneyIntentRow = typeof evergreenOfferJourneyIntent.$inferSelect
type JourneyWakeRow = typeof evergreenOfferJourneyWake.$inferSelect

type JourneyCondition = SQL | undefined

type JourneyQueryConfig = {
	readonly where: JourneyCondition
	readonly orderBy?: readonly SQL[]
}

type JourneyTable =
	| typeof evergreenOfferJourneyCommit
	| typeof evergreenOfferJourneyIntent
	| typeof evergreenOfferJourneyWake

type JourneyInsertValues =
	| typeof evergreenOfferJourneyCommit.$inferInsert
	| typeof evergreenOfferJourneyIntent.$inferInsert
	| typeof evergreenOfferJourneyWake.$inferInsert
	| readonly (
			| typeof evergreenOfferJourneyIntent.$inferInsert
			| typeof evergreenOfferJourneyWake.$inferInsert
	  )[]

type JourneyUpdateValues =
	| Partial<typeof evergreenOfferJourneyIntent.$inferInsert>
	| Partial<typeof evergreenOfferJourneyWake.$inferInsert>

type JourneyWriteReceipt = {
	readonly databaseAcknowledged?: boolean
	readonly rowsAffected?: number
}

type JourneyQuery<Row> = {
	findFirst(args: JourneyQueryConfig): Promise<Row | undefined>
	findMany(args: JourneyQueryConfig): Promise<Row[]>
}

type JourneyInsert = {
	values(values: JourneyInsertValues): Promise<JourneyWriteReceipt>
}

type JourneyUpdate = {
	set(values: JourneyUpdateValues): {
		where(condition: JourneyCondition): Promise<JourneyWriteReceipt>
	}
}

export type EvergreenOfferJourneyTransaction = {
	readonly query: {
		readonly evergreenOfferJourneyCommit: JourneyQuery<JourneyCommitRow>
		readonly evergreenOfferJourneyIntent: JourneyQuery<JourneyIntentRow>
		readonly evergreenOfferJourneyWake: JourneyQuery<JourneyWakeRow>
	}
	readonly execute: (query: SQL) => Promise<JourneyWriteReceipt>
	readonly insert: (table: JourneyTable) => JourneyInsert
	readonly update: (table: JourneyTable) => JourneyUpdate
}

type JourneyDatabaseAdapter = EvergreenOfferJourneyTransaction & {
	readonly transaction: <Value>(
		work: (transaction: EvergreenOfferJourneyTransaction) => Promise<Value>,
	) => Promise<Value>
}

type JourneyDatabase = JourneyDatabaseAdapter
type JourneyTransaction = EvergreenOfferJourneyTransaction
type StoredCommit = typeof evergreenOfferJourneyCommit.$inferSelect

type CommitIdentity = {
	readonly stimulusId: string
	readonly journeyId: string
	readonly actorVersion: number
	readonly decidedAt: string
	readonly committedAt: string
	readonly evidence: JourneyCommitEvidence
	readonly events: readonly JourneyDomainEvent[]
}

type IntentSettlementStatus = 'Applied' | 'Refused' | 'Ambiguous' | 'Missed'

class JourneyLedgerAbort extends Error {
	constructor(readonly error: JourneyCommandError | JourneyQueryError) {
		super(error.type)
	}
}

export function createDrizzleJourneyLedger(
	drizzleDatabase: EvergreenOfferJourneyDatabase,
): DrizzleJourneyLedger {
	// SAFETY: the public boundary requires Drizzle's concrete MySQL2 database
	// with the complete journey schema. This local adapter erases only query-
	// builder generics while preserving the runtime methods used below.
	const database = drizzleDatabase as unknown as JourneyDatabase
	const load: JourneyLedger['load'] = (journeyId) =>
		Effect.tryPromise({
			try: async () => loadAggregate(database, journeyId),
			catch: (cause) => commandReadError(cause),
		})

	const findCommittedStimulus: JourneyLedger['findCommittedStimulus'] = (
		stimulusId,
	) =>
		Effect.tryPromise({
			try: async () => {
				const row = await database.query.evergreenOfferJourneyCommit.findFirst({
					where: eq(evergreenOfferJourneyCommit.stimulusId, stimulusId),
				})
				return row ? readCommittedDecision(database, row) : null
			},
			catch: (cause) => commandError(cause),
		})

	const commit: JourneyLedger['commit'] = (candidateInput) =>
		Effect.tryPromise({
			try: async () => {
				const candidate = structuredClone(candidateInput)
				for (let attempt = 0; attempt < 3; attempt += 1) {
					try {
						return await database.transaction((transaction) =>
							commitInTransaction(transaction, candidate),
						)
					} catch (cause) {
						if (isRetryableTransactionRace(cause) && attempt < 2) continue
						const replay =
							await database.query.evergreenOfferJourneyCommit.findFirst({
								where: eq(
									evergreenOfferJourneyCommit.stimulusId,
									candidate.stimulus.stimulusId,
								),
							})
						if (replay) {
							const committed = await readCommittedDecision(database, replay)
							return replayed(committed.decision)
						}
						if (!isMysqlDuplicateEntryError(cause)) throw cause
						const latest =
							await database.query.evergreenOfferJourneyCommit.findFirst({
								where: eq(
									evergreenOfferJourneyCommit.journeyId,
									candidate.decision.next.journeyId,
								),
								orderBy: [desc(evergreenOfferJourneyCommit.actorVersion)],
							})
						if ((latest?.actorVersion ?? null) !== candidate.expectedVersion) {
							throw new JourneyLedgerAbort({
								type: 'JourneyVersionConflict',
								journeyId: candidate.decision.next.journeyId,
							})
						}
						throw new JourneyLedgerAbort(
							constraintFailure(
								candidate,
								'Duplicate semantic intent or wake identity',
							),
						)
					}
				}
				throw new JourneyLedgerAbort({
					type: 'JourneyCommitUnavailable',
					reason: 'Transaction retry budget exhausted',
				})
			},
			catch: (cause) => commandError(cause),
		})

	const inspect: JourneyLedger['inspect'] = (query) =>
		Effect.tryPromise({
			try: async () => inspectJourney(database, query),
			catch: (cause) => queryError(cause),
		})

	return { load, findCommittedStimulus, commit, inspect }
}

async function commitInTransaction(
	transaction: JourneyTransaction,
	candidate: JourneyLedgerCommit,
): Promise<CommittedJourneyDecision> {
	const existingStimulus =
		await transaction.query.evergreenOfferJourneyCommit.findFirst({
			where: eq(
				evergreenOfferJourneyCommit.stimulusId,
				candidate.stimulus.stimulusId,
			),
		})
	if (existingStimulus) {
		const committed = await readCommittedDecision(transaction, existingStimulus)
		return replayed(committed.decision)
	}

	const journeyId = candidate.decision.next.journeyId
	await transaction.execute(
		sql`SELECT ${evergreenOfferJourneyCommit.journeyId}, ${evergreenOfferJourneyCommit.actorVersion} FROM ${evergreenOfferJourneyCommit} WHERE ${evergreenOfferJourneyCommit.journeyId} = ${journeyId} ORDER BY ${evergreenOfferJourneyCommit.actorVersion} DESC LIMIT 1 FOR UPDATE`,
	)
	const head = await transaction.query.evergreenOfferJourneyCommit.findFirst({
		where: eq(evergreenOfferJourneyCommit.journeyId, journeyId),
		orderBy: [desc(evergreenOfferJourneyCommit.actorVersion)],
	})
	const current = head
		? acceptedDecision(
				(await readCommittedDecision(transaction, head)).decision,
			).next
		: null

	const candidateIntentKeys = candidate.decision.sideEffectIntents.map(
		(intent) => intent.idempotencyKey,
	)
	const existingIntents =
		candidateIntentKeys.length === 0
			? []
			: await transaction.query.evergreenOfferJourneyIntent.findMany({
					where: inArray(
						evergreenOfferJourneyIntent.idempotencyKey,
						candidateIntentKeys,
					),
				})
	const candidateWakeIds = candidate.decision.wakeIntents.map(
		(wake) => wake.wakeId,
	)
	const existingWakes =
		candidateWakeIds.length === 0
			? []
			: await transaction.query.evergreenOfferJourneyWake.findMany({
					where: inArray(evergreenOfferJourneyWake.wakeId, candidateWakeIds),
				})

	for (const existing of existingIntents) {
		restoreIntentRow(
			existing,
			await operationalCommitMap(transaction, existing),
		)
	}
	for (const existing of existingWakes) {
		restoreWakeRow(existing, await operationalCommitMap(transaction, existing))
	}

	const validationFailure = validateCommit({
		candidate,
		current,
		existingIntentKeys: new Set(
			existingIntents.map((row) => row.idempotencyKey),
		),
		existingWakeIds: new Set(existingWakes.map((row) => row.wakeId)),
	})
	if (validationFailure) throw new JourneyLedgerAbort(validationFailure)

	const snapshot = snapshotValue(candidate.decision.next)
	const actorVersion = candidate.decision.next.version
	const committedAt = new Date(candidate.decision.transitionReceipt.committedAt)
	await transaction.insert(evergreenOfferJourneyCommit).values({
		format: EVERGREEN_OFFER_JOURNEY_COMMIT_FORMAT,
		stimulusId: candidate.stimulus.stimulusId,
		journeyId,
		actorVersion,
		stimulusType: candidate.stimulus.type,
		commitEvidence: journeyCommitEvidenceRecord(candidate),
		decision: candidate.decision,
		snapshot,
		events: candidate.decision.events,
		receipt: candidate.decision.transitionReceipt,
		decidedAt: new Date(candidate.decidedAt),
		committedAt,
	})

	if (candidate.decision.sideEffectIntents.length > 0) {
		await transaction.insert(evergreenOfferJourneyIntent).values(
			candidate.decision.sideEffectIntents.map((intent, ordinal) => ({
				format: EVERGREEN_OFFER_JOURNEY_INTENT_FORMAT,
				idempotencyKey: intent.idempotencyKey,
				journeyId,
				originatingStimulusId: candidate.stimulus.stimulusId,
				actorVersion,
				ordinal,
				intentType: intent.type,
				intent,
				status: 'Pending',
				settledByStimulusId: null,
				settledAt: null,
				createdAt: committedAt,
				updatedAt: committedAt,
			})),
		)
	}

	if (candidate.decision.wakeIntents.length > 0) {
		await transaction.insert(evergreenOfferJourneyWake).values(
			candidate.decision.wakeIntents.map((wake, ordinal) => ({
				format: EVERGREEN_OFFER_JOURNEY_WAKE_FORMAT,
				wakeId: wake.wakeId,
				journeyId,
				originatingStimulusId: candidate.stimulus.stimulusId,
				actorVersion,
				ordinal,
				purposeType: wake.purpose.type,
				dueAt: new Date(wake.dueAt),
				wake,
				status: 'Pending',
				settledByStimulusId: null,
				settledAt: null,
				createdAt: committedAt,
				updatedAt: committedAt,
			})),
		)
	}

	await settleExistingIntentRecords(transaction, candidate)
	await settleExistingWakeRecord(transaction, candidate)

	return committed(candidate.decision)
}

async function settleExistingIntentRecords(
	transaction: JourneyTransaction,
	candidate: JourneyLedgerCommit,
) {
	for (const [idempotencyKey, status] of intentSettlements(candidate)) {
		const existing =
			await transaction.query.evergreenOfferJourneyIntent.findFirst({
				where: and(
					eq(evergreenOfferJourneyIntent.idempotencyKey, idempotencyKey),
					eq(
						evergreenOfferJourneyIntent.journeyId,
						candidate.decision.next.journeyId,
					),
				),
			})
		if (!existing) {
			throw settlementConstraint(
				candidate,
				`Settlement references unknown intent key ${idempotencyKey}`,
			)
		}
		restoreIntentRow(
			existing,
			await operationalCommitMap(transaction, existing),
		)
		if (!allowsIntentSettlement(existing, status, candidate)) {
			throw settlementConstraint(
				candidate,
				`Intent ${idempotencyKey} is not in an allowed settlement state`,
			)
		}
		const write = await transaction
			.update(evergreenOfferJourneyIntent)
			.set({
				status,
				settledByStimulusId: candidate.stimulus.stimulusId,
				settledAt: new Date(candidate.decidedAt),
				updatedAt: new Date(candidate.decidedAt),
			})
			.where(
				and(
					eq(evergreenOfferJourneyIntent.idempotencyKey, idempotencyKey),
					eq(
						evergreenOfferJourneyIntent.journeyId,
						candidate.decision.next.journeyId,
					),
					eq(evergreenOfferJourneyIntent.status, existing.status),
					existing.settledByStimulusId === null
						? isNull(evergreenOfferJourneyIntent.settledByStimulusId)
						: eq(
								evergreenOfferJourneyIntent.settledByStimulusId,
								existing.settledByStimulusId,
							),
					existing.settledAt === null
						? isNull(evergreenOfferJourneyIntent.settledAt)
						: eq(evergreenOfferJourneyIntent.settledAt, existing.settledAt),
				),
			)
		if (writtenRows(write) !== 1) {
			throw settlementConstraint(
				candidate,
				`Intent ${idempotencyKey} changed before settlement commit`,
			)
		}
	}
}

async function settleExistingWakeRecord(
	transaction: JourneyTransaction,
	candidate: JourneyLedgerCommit,
) {
	if (candidate.stimulus.type !== 'WakeDue') return
	const existing = await transaction.query.evergreenOfferJourneyWake.findFirst({
		where: and(
			eq(evergreenOfferJourneyWake.wakeId, candidate.stimulus.wakeId),
			eq(
				evergreenOfferJourneyWake.journeyId,
				candidate.decision.next.journeyId,
			),
		),
	})
	if (!existing) {
		throw settlementConstraint(
			candidate,
			`Wake receipt references unknown wake ID ${candidate.stimulus.wakeId}`,
		)
	}
	restoreWakeRow(existing, await operationalCommitMap(transaction, existing))
	if (
		existing.status !== 'Pending' ||
		existing.settledByStimulusId !== null ||
		existing.settledAt !== null
	) {
		throw settlementConstraint(
			candidate,
			`Wake ${candidate.stimulus.wakeId} is already settled`,
		)
	}
	const write = await transaction
		.update(evergreenOfferJourneyWake)
		.set({
			status: 'Applied',
			settledByStimulusId: candidate.stimulus.stimulusId,
			settledAt: new Date(candidate.decidedAt),
			updatedAt: new Date(candidate.decidedAt),
		})
		.where(
			and(
				eq(evergreenOfferJourneyWake.wakeId, candidate.stimulus.wakeId),
				eq(
					evergreenOfferJourneyWake.journeyId,
					candidate.decision.next.journeyId,
				),
				eq(evergreenOfferJourneyWake.status, 'Pending'),
				isNull(evergreenOfferJourneyWake.settledByStimulusId),
				isNull(evergreenOfferJourneyWake.settledAt),
			),
		)
	if (writtenRows(write) !== 1) {
		throw settlementConstraint(
			candidate,
			`Wake ${candidate.stimulus.wakeId} changed before settlement commit`,
		)
	}
}

async function operationalCommitMap(
	transaction: JourneyTransaction,
	row: Pick<
		JourneyIntentRow | JourneyWakeRow,
		'originatingStimulusId' | 'settledByStimulusId'
	>,
) {
	const stimulusIds = [row.originatingStimulusId]
	if (row.settledByStimulusId !== null) {
		stimulusIds.push(row.settledByStimulusId)
	}
	const commits = await transaction.query.evergreenOfferJourneyCommit.findMany({
		where: inArray(evergreenOfferJourneyCommit.stimulusId, stimulusIds),
	})
	await Promise.all(
		commits.map((commit) => readCommittedDecision(transaction, commit)),
	)
	return commitIdentityMap(commits)
}

function allowsIntentSettlement(
	existing: JourneyIntentRow,
	status: IntentSettlementStatus,
	candidate: JourneyLedgerCommit,
) {
	if (
		existing.status === 'Pending' &&
		existing.settledByStimulusId === null &&
		existing.settledAt === null
	) {
		return true
	}
	if (
		existing.status !== 'Missed' ||
		candidate.stimulus.type !== 'DeliverySettled'
	) {
		return false
	}
	const expectedStatus: IntentSettlementStatus =
		candidate.stimulus.outcome.type === 'Applied'
			? 'Applied'
			: candidate.stimulus.outcome.type === 'Ambiguous'
				? 'Ambiguous'
				: 'Refused'
	return status === expectedStatus
}

function writtenRows(receipt: JourneyWriteReceipt) {
	const candidates: unknown[] = [receipt]
	if (Array.isArray(receipt)) candidates.push(...receipt)
	for (const candidate of candidates) {
		if (!candidate || typeof candidate !== 'object') continue
		if (
			'rowsAffected' in candidate &&
			typeof candidate.rowsAffected === 'number'
		) {
			return candidate.rowsAffected
		}
		if (
			'affectedRows' in candidate &&
			typeof candidate.affectedRows === 'number'
		) {
			return candidate.affectedRows
		}
	}
	return null
}

function settlementConstraint(candidate: JourneyLedgerCommit, reason: string) {
	return new JourneyLedgerAbort(constraintFailure(candidate, reason))
}

async function loadAggregate(
	database: JourneyDatabase,
	journeyId: JourneyId,
): Promise<EvergreenOfferJourneyAggregate | null> {
	const head = await database.query.evergreenOfferJourneyCommit.findFirst({
		where: eq(evergreenOfferJourneyCommit.journeyId, journeyId),
		orderBy: [desc(evergreenOfferJourneyCommit.actorVersion)],
	})
	if (!head) return null
	const committedDecision = await readCommittedDecision(database, head)
	return acceptedDecision(committedDecision.decision).next
}

async function readCommittedDecision(
	database: Pick<JourneyDatabase, 'query'>,
	row: StoredCommit,
): Promise<CommittedJourneyDecision> {
	const rowIdentity = commitIdentity(row)
	const evidence = rowIdentity.evidence
	const next = restoreSnapshot(row.snapshot, row.journeyId, row.actorVersion)
	if (
		evidence.currentFacts.contactId !== next.contactId ||
		(evidence.stimulus.type === 'CourseSequenceExhausted' &&
			evidence.stimulus.contactId !== next.contactId) ||
		(row.actorVersion === 1
			? evidence.currentFacts.existingJourneyId !== null
			: evidence.currentFacts.existingJourneyId !== row.journeyId) ||
		!jsonDeepEqual(evidence.definition, next.definition)
	) {
		decodeFailure(
			`Commit evidence for ${row.stimulusId} does not match the aggregate identity or pinned definition`,
		)
	}
	const previous =
		row.actorVersion === 1
			? null
			: await database.query.evergreenOfferJourneyCommit.findFirst({
					where: and(
						eq(evergreenOfferJourneyCommit.journeyId, row.journeyId),
						eq(evergreenOfferJourneyCommit.actorVersion, row.actorVersion - 1),
					),
				})
	if (row.actorVersion > 1 && !previous) {
		decodeFailure(`Commit ${row.stimulusId} has no previous actor version`)
	}
	if (previous) commitIdentity(previous)
	const previousAggregate = previous
		? restoreSnapshot(
				previous.snapshot,
				previous.journeyId,
				previous.actorVersion,
			)
		: null
	const previousPhase = previousAggregate?.phase ?? 'not_started'
	const events = restoredValue(
		restorePersistedDomainEvents(row.events),
		`events for ${row.stimulusId}`,
	)
	const receipt = restoredValue(
		restorePersistedTransitionReceipt(row.receipt),
		`receipt ${row.stimulusId}`,
	)
	if (
		receipt.stimulusId !== row.stimulusId ||
		receipt.journeyId !== row.journeyId ||
		receipt.from !== previousPhase ||
		receipt.to !== next.phase ||
		receipt.committedAt !== rowIdentity.committedAt
	) {
		decodeFailure(`Receipt ${row.stimulusId} does not match its commit row`)
	}
	const [intentRows, wakeRows] = await Promise.all([
		database.query.evergreenOfferJourneyIntent.findMany({
			where: and(
				eq(evergreenOfferJourneyIntent.journeyId, row.journeyId),
				eq(evergreenOfferJourneyIntent.actorVersion, row.actorVersion),
			),
			orderBy: [asc(evergreenOfferJourneyIntent.ordinal)],
		}),
		database.query.evergreenOfferJourneyWake.findMany({
			where: and(
				eq(evergreenOfferJourneyWake.journeyId, row.journeyId),
				eq(evergreenOfferJourneyWake.actorVersion, row.actorVersion),
			),
			orderBy: [asc(evergreenOfferJourneyWake.ordinal)],
		}),
	])
	validateOrdinals(intentRows, `intents for ${row.stimulusId}`)
	validateOrdinals(wakeRows, `wakes for ${row.stimulusId}`)
	const settlementIds = [
		...intentRows.map((candidate) => candidate.settledByStimulusId),
		...wakeRows.map((candidate) => candidate.settledByStimulusId),
	].filter((candidate): candidate is string => candidate !== null)
	const settlementRows =
		settlementIds.length === 0
			? []
			: await database.query.evergreenOfferJourneyCommit.findMany({
					where: inArray(evergreenOfferJourneyCommit.stimulusId, settlementIds),
				})
	const commitsByStimulus = commitIdentityMap([row, ...settlementRows])
	const restoredIntents = intentRows.map((intentRow) =>
		restoreIntentRow(intentRow, commitsByStimulus),
	)
	const restoredWakes = wakeRows.map((wakeRow) =>
		restoreWakeRow(wakeRow, commitsByStimulus),
	)
	const decision: Extract<JourneyDecision, { type: 'Accepted' }> = {
		type: 'Accepted',
		next,
		events,
		sideEffectIntents: restoredIntents.map((record) => record.intent),
		wakeIntents: restoredWakes.map((record) => record.wake),
		transitionReceipt: receipt,
	}
	if (!jsonDeepEqual(row.decision, decision)) {
		decodeFailure(
			`Stored stimulus ${row.stimulusId} does not match its normalized records`,
		)
	}
	const recomputed = decideEvergreenOfferJourney({
		snapshot: previousAggregate,
		stimulus: evidence.stimulus,
		currentFacts: evidence.currentFacts,
		definition: evidence.definition,
		now: evidence.decidedAt,
	})
	if (
		!recomputed.ok ||
		recomputed.decision.type !== 'Accepted' ||
		!jsonDeepEqual(recomputed.decision, decision)
	) {
		decodeFailure(
			`Stored stimulus ${row.stimulusId} does not reproduce its committed decision`,
		)
	}
	return committed(decision)
}

async function inspectJourney(
	database: JourneyDatabase,
	query: Parameters<JourneyLedger['inspect']>[0],
): Promise<JourneyView> {
	const aggregate = await loadAggregate(database, query.journeyId)
	if (!aggregate) {
		throw new JourneyLedgerAbort({
			type: 'JourneyNotFound',
			journeyId: query.journeyId,
		})
	}
	const [intentRows, wakeRows, receiptRows] = await Promise.all([
		database.query.evergreenOfferJourneyIntent.findMany({
			where: eq(evergreenOfferJourneyIntent.journeyId, query.journeyId),
			orderBy: [
				asc(evergreenOfferJourneyIntent.actorVersion),
				asc(evergreenOfferJourneyIntent.ordinal),
			],
		}),
		database.query.evergreenOfferJourneyWake.findMany({
			where: eq(evergreenOfferJourneyWake.journeyId, query.journeyId),
			orderBy: [
				asc(evergreenOfferJourneyWake.actorVersion),
				asc(evergreenOfferJourneyWake.ordinal),
			],
		}),
		database.query.evergreenOfferJourneyCommit.findMany({
			where: eq(evergreenOfferJourneyCommit.journeyId, query.journeyId),
			orderBy: [asc(evergreenOfferJourneyCommit.actorVersion)],
		}),
	])

	const committedDecisions = await Promise.all(
		receiptRows.map((row) => readCommittedDecision(database, row)),
	)
	const commitsByStimulus = commitIdentityMap(receiptRows)
	const restoredIntents = intentRows.map((row) =>
		restoreIntentRow(row, commitsByStimulus),
	)
	const restoredWakes = wakeRows.map((row) =>
		restoreWakeRow(row, commitsByStimulus),
	)
	return inspectEvergreenOfferJourney({
		aggregate,
		now: query.now,
		automationControl: query.automationControl,
		intentEvidence: restoredIntents.map((record) => ({
			intent: record.intent,
			status: record.status,
		})),
		wakeEvidence: restoredWakes.map((record) => ({
			wake: record.wake,
			status: record.status,
		})),
		transitionReceipts: committedDecisions.map(
			(record) => acceptedDecision(record.decision).transitionReceipt,
		),
		evidenceVersion: `mysql:${aggregate.version}`,
	})
}

function acceptedDecision(decision: JourneyDecision) {
	if (decision.type !== 'Accepted') {
		decodeFailure('Committed decision is not an accepted transition')
	}
	return decision
}

function commitIdentity(row: StoredCommit): CommitIdentity {
	if (row.format !== EVERGREEN_OFFER_JOURNEY_COMMIT_FORMAT) {
		decodeFailure(`Unsupported commit format for ${row.stimulusId}`)
	}
	if (!Number.isInteger(row.actorVersion) || row.actorVersion < 1) {
		decodeFailure(`Invalid actor version for ${row.stimulusId}`)
	}
	const decidedAt = persistedDate(row.decidedAt, `decision ${row.stimulusId}`)
	const committedAt = persistedDate(row.committedAt, `commit ${row.stimulusId}`)
	if (decidedAt !== committedAt) {
		decodeFailure(`Commit ${row.stimulusId} decision and commit times disagree`)
	}
	const evidence = validatePersistedCommitEvidenceEnvelope(row.commitEvidence, {
		stimulusId: row.stimulusId,
		stimulusType: row.stimulusType,
		journeyId: row.journeyId,
		actorVersion: row.actorVersion,
		decidedAt,
	})
	if (!evidence.ok) throw new JourneyLedgerAbort(evidence.error)
	return {
		stimulusId: row.stimulusId,
		journeyId: row.journeyId,
		actorVersion: row.actorVersion,
		decidedAt,
		committedAt,
		evidence: evidence.value,
		events: restoredValue(
			restorePersistedDomainEvents(row.events),
			`events for ${row.stimulusId}`,
		),
	}
}

function commitIdentityMap(rows: readonly StoredCommit[]) {
	const commits = new Map<string, CommitIdentity>()
	for (const row of rows) {
		const identity = commitIdentity(row)
		if (commits.has(identity.stimulusId)) {
			decodeFailure(`Duplicate commit identity ${identity.stimulusId}`)
		}
		commits.set(identity.stimulusId, identity)
	}
	return commits
}

function validateOrdinals(
	rows: readonly { readonly ordinal: number }[],
	label: string,
) {
	rows.forEach((row, index) => {
		if (row.ordinal !== index) {
			decodeFailure(`${label} have a non-contiguous ordinal sequence`)
		}
	})
}

function restoreIntentRow(
	row: JourneyIntentRow,
	commitsByStimulus: ReadonlyMap<string, CommitIdentity>,
) {
	if (row.format !== EVERGREEN_OFFER_JOURNEY_INTENT_FORMAT) {
		decodeFailure(`Unsupported intent format for ${row.idempotencyKey}`)
	}
	if (
		!Number.isInteger(row.actorVersion) ||
		row.actorVersion < 1 ||
		!Number.isInteger(row.ordinal) ||
		row.ordinal < 0
	) {
		decodeFailure(`Invalid intent position for ${row.idempotencyKey}`)
	}
	const intent = restoredValue(
		restorePersistedSideEffectIntent(row.intent),
		`intent ${row.idempotencyKey}`,
	)
	if (
		intent.idempotencyKey !== row.idempotencyKey ||
		intent.type !== row.intentType ||
		intent.journeyId !== row.journeyId
	) {
		decodeFailure(
			`Intent ${row.idempotencyKey} disagrees with its indexed fields`,
		)
	}
	const origin = commitsByStimulus.get(row.originatingStimulusId)
	if (
		!origin ||
		origin.journeyId !== row.journeyId ||
		origin.actorVersion !== row.actorVersion
	) {
		decodeFailure(`Intent ${row.idempotencyKey} has no matching origin commit`)
	}
	if (
		persistedDate(row.createdAt, `intent ${row.idempotencyKey} creation`) !==
		origin.committedAt
	) {
		decodeFailure(`Intent ${row.idempotencyKey} creation time disagrees`)
	}
	const status = intentEvidenceStatus(row.status)
	const settlement = validateSettlementFields({
		label: `intent ${row.idempotencyKey}`,
		journeyId: row.journeyId,
		status: row.status,
		settledByStimulusId: row.settledByStimulusId,
		settledAt: row.settledAt,
		commitsByStimulus,
	})
	if (settlement && !settlesIntent(intent, row.status, settlement)) {
		decodeFailure(`Intent ${row.idempotencyKey} settlement evidence disagrees`)
	}
	const expectedUpdatedAt = settlement?.decidedAt ?? origin.committedAt
	if (
		persistedDate(row.updatedAt, `intent ${row.idempotencyKey} update`) !==
		expectedUpdatedAt
	) {
		decodeFailure(`Intent ${row.idempotencyKey} update time disagrees`)
	}
	return { intent, status }
}

function restoreWakeRow(
	row: JourneyWakeRow,
	commitsByStimulus: ReadonlyMap<string, CommitIdentity>,
) {
	if (row.format !== EVERGREEN_OFFER_JOURNEY_WAKE_FORMAT) {
		decodeFailure(`Unsupported wake format for ${row.wakeId}`)
	}
	if (
		!Number.isInteger(row.actorVersion) ||
		row.actorVersion < 1 ||
		!Number.isInteger(row.ordinal) ||
		row.ordinal < 0
	) {
		decodeFailure(`Invalid wake position for ${row.wakeId}`)
	}
	const wake = restoredValue(
		restorePersistedScheduleWake(row.wake),
		`wake ${row.wakeId}`,
	)
	if (
		wake.wakeId !== row.wakeId ||
		wake.purpose.type !== row.purposeType ||
		wake.journeyId !== row.journeyId ||
		wake.dueAt !== persistedDate(row.dueAt, `wake ${row.wakeId}`)
	) {
		decodeFailure(`Wake ${row.wakeId} disagrees with its indexed fields`)
	}
	const origin = commitsByStimulus.get(row.originatingStimulusId)
	if (
		!origin ||
		origin.journeyId !== row.journeyId ||
		origin.actorVersion !== row.actorVersion
	) {
		decodeFailure(`Wake ${row.wakeId} has no matching origin commit`)
	}
	if (
		persistedDate(row.createdAt, `wake ${row.wakeId} creation`) !==
		origin.committedAt
	) {
		decodeFailure(`Wake ${row.wakeId} creation time disagrees`)
	}
	const status = wakeEvidenceStatus(row.status)
	const settlement = validateSettlementFields({
		label: `wake ${row.wakeId}`,
		journeyId: row.journeyId,
		status: row.status,
		settledByStimulusId: row.settledByStimulusId,
		settledAt: row.settledAt,
		commitsByStimulus,
	})
	if (
		settlement &&
		(settlement.evidence.stimulus.type !== 'WakeDue' ||
			settlement.evidence.stimulus.wakeId !== wake.wakeId)
	) {
		decodeFailure(`Wake ${row.wakeId} settlement evidence disagrees`)
	}
	const expectedUpdatedAt = settlement?.decidedAt ?? origin.committedAt
	if (
		persistedDate(row.updatedAt, `wake ${row.wakeId} update`) !==
		expectedUpdatedAt
	) {
		decodeFailure(`Wake ${row.wakeId} update time disagrees`)
	}
	return { wake, status }
}

function validateSettlementFields(args: {
	readonly label: string
	readonly journeyId: string
	readonly status: string
	readonly settledByStimulusId: string | null
	readonly settledAt: Date | null
	readonly commitsByStimulus: ReadonlyMap<string, CommitIdentity>
}) {
	if (args.status === 'Pending') {
		if (args.settledByStimulusId !== null || args.settledAt !== null) {
			decodeFailure(`${args.label} is pending with settlement evidence`)
		}
		return null
	}
	if (args.settledByStimulusId === null || args.settledAt === null) {
		decodeFailure(`${args.label} is terminal without settlement evidence`)
	}
	const settlement = args.commitsByStimulus.get(args.settledByStimulusId)
	if (
		!settlement ||
		settlement.journeyId !== args.journeyId ||
		settlement.decidedAt !== persistedDate(args.settledAt, args.label)
	) {
		decodeFailure(
			`${args.label} settlement does not match a committed stimulus`,
		)
	}
	return settlement
}

function settlesIntent(
	intent: SideEffectIntent,
	status: string,
	settlement: CommitIdentity,
) {
	const stimulus = settlement.evidence.stimulus
	if ('intentKey' in stimulus && stimulus.intentKey !== intent.idempotencyKey) {
		return false
	}
	switch (status) {
		case 'Applied':
			return (
				(intent.type === 'SendMessage' &&
					stimulus.type === 'DeliverySettled' &&
					stimulus.outcome.type === 'Applied') ||
				(intent.type === 'IssueCoupon' && stimulus.type === 'CouponIssued') ||
				(intent.type === 'BindCoupon' &&
					stimulus.type === 'CouponBoundToUser') ||
				(intent.type === 'EnterShadowNewsletter' &&
					stimulus.type === 'ShadowNewsletterEntered')
			)
		case 'Refused':
			return (
				(intent.type === 'SendMessage' &&
					stimulus.type === 'DeliverySettled' &&
					(stimulus.outcome.type === 'MessageRefused' ||
						stimulus.outcome.type === 'ContactUndeliverable')) ||
				stimulus.type === 'PermanentEffectRefusal'
			)
		case 'Ambiguous':
			return (
				intent.type === 'SendMessage' &&
				stimulus.type === 'DeliverySettled' &&
				stimulus.outcome.type === 'Ambiguous'
			)
		case 'Missed':
			return settlement.events.some(
				(event) =>
					event.type === 'MessageMissed' &&
					event.details.intentKey === intent.idempotencyKey,
			)
		default:
			return false
	}
}

function persistedDate(value: Date, label: string) {
	if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
		decodeFailure(`Invalid persisted timestamp for ${label}`)
	}
	return value.toISOString()
}

function decodeFailure(reason: string): never {
	throw new JourneyLedgerAbort({ type: 'JourneyDecodeFailure', reason })
}

function validateCommit(args: {
	readonly candidate: JourneyLedgerCommit
	readonly current: EvergreenOfferJourneyAggregate | null
	readonly existingIntentKeys: ReadonlySet<string>
	readonly existingWakeIds: ReadonlySet<string>
}): JourneyCommandError | null {
	const { candidate, current } = args
	if (
		(current === null && candidate.expectedVersion !== null) ||
		(current !== null && current.version !== candidate.expectedVersion)
	) {
		return {
			type: 'JourneyVersionConflict',
			journeyId: candidate.decision.next.journeyId,
		}
	}
	const recomputed = decideEvergreenOfferJourney({
		snapshot: current,
		stimulus: candidate.stimulus,
		currentFacts: candidate.currentFacts,
		definition: candidate.definition,
		now: candidate.decidedAt,
	})
	if (
		!recomputed.ok ||
		recomputed.decision.type !== 'Accepted' ||
		!jsonDeepEqual(recomputed.decision, candidate.decision)
	) {
		return constraintFailure(
			candidate,
			'Committed decision does not match the pure journey decision',
		)
	}
	if (
		(current === null && candidate.decision.next.version !== 1) ||
		(current !== null &&
			(candidate.decision.next.version !== current.version + 1 ||
				candidate.decision.next.journeyId !== current.journeyId ||
				candidate.decision.next.entryFactId !== current.entryFactId ||
				candidate.decision.next.contactId !== current.contactId))
	) {
		return constraintFailure(
			candidate,
			'Next aggregate must preserve actor identity and increment one version',
		)
	}
	const intentKeys = candidate.decision.sideEffectIntents.map(
		(intent) => intent.idempotencyKey,
	)
	if (
		new Set(intentKeys).size !== intentKeys.length ||
		intentKeys.some((key) => args.existingIntentKeys.has(key))
	) {
		return constraintFailure(
			candidate,
			'Side-effect intent key must be unique across the ledger',
		)
	}
	const wakeIds = candidate.decision.wakeIntents.map((wake) => wake.wakeId)
	if (
		new Set(wakeIds).size !== wakeIds.length ||
		wakeIds.some((wakeId) => args.existingWakeIds.has(wakeId))
	) {
		return constraintFailure(
			candidate,
			'Wake ID must be unique across the ledger',
		)
	}
	return null
}

function intentSettlements(
	candidate: JourneyLedgerCommit,
): ReadonlyMap<IntentKey, IntentSettlementStatus> {
	const settlements = new Map<IntentKey, IntentSettlementStatus>()
	const stimulus = candidate.stimulus
	switch (stimulus.type) {
		case 'DeliverySettled':
			settlements.set(
				stimulus.intentKey,
				stimulus.outcome.type === 'Applied'
					? 'Applied'
					: stimulus.outcome.type === 'Ambiguous'
						? 'Ambiguous'
						: 'Refused',
			)
			break
		case 'CouponIssued':
		case 'CouponBoundToUser':
		case 'ShadowNewsletterEntered':
			settlements.set(stimulus.intentKey, 'Applied')
			break
		case 'PermanentEffectRefusal':
			settlements.set(stimulus.intentKey, 'Refused')
			break
	}
	for (const event of candidate.decision.events) {
		if (event.type === 'MessageMissed' && event.details.intentKey) {
			settlements.set(event.details.intentKey, 'Missed')
		}
	}
	return settlements
}

function restoreSnapshot(
	input: unknown,
	expectedJourneyId: string,
	expectedVersion: number,
): EvergreenOfferJourneyAggregate {
	const restored = restoreEvergreenOfferJourneySnapshot(toJson(input))
	if (!restored.ok) throw new JourneyLedgerAbort(restored.error)
	if (
		restored.value.journeyId !== expectedJourneyId ||
		restored.value.version !== expectedVersion
	) {
		throw new JourneyLedgerAbort({
			type: 'JourneyDecodeFailure',
			reason: 'Snapshot row identity does not match its restored aggregate',
		})
	}
	return restored.value
}

function snapshotValue(aggregate: EvergreenOfferJourneyAggregate): unknown {
	return JSON.parse(encodeEvergreenOfferJourneySnapshot(aggregate))
}

function committed(
	decision: Extract<JourneyDecision, { type: 'Accepted' }>,
): CommittedJourneyDecision {
	return {
		decision: structuredClone(decision),
		committed: true,
		replayedStimulus: false,
	}
}

function replayed(decision: JourneyDecision): CommittedJourneyDecision {
	return {
		decision: structuredClone(decision),
		committed: false,
		replayedStimulus: true,
	}
}

function constraintFailure(
	candidate: JourneyLedgerCommit,
	reason: string,
): Extract<JourneyCommandError, { type: 'JourneyConstraintViolation' }> {
	return {
		type: 'JourneyConstraintViolation',
		journeyId: candidate.decision.next.journeyId,
		reason,
	}
}

function restoredValue<Value>(
	result:
		| { readonly ok: true; readonly value: Value }
		| {
				readonly ok: false
				readonly error: {
					readonly type: 'JourneyDecodeFailure'
					readonly reason: string
				}
		  },
	label: string,
): Value {
	if (result.ok) return result.value
	throw new JourneyLedgerAbort({
		type: 'JourneyDecodeFailure',
		reason: `${label}: ${result.error.reason}`,
	})
}

function intentEvidenceStatus(
	status: string,
): 'pending' | 'applied' | 'refused' | 'ambiguous' | 'missed' {
	switch (status) {
		case 'Pending':
			return 'pending'
		case 'Applied':
			return 'applied'
		case 'Refused':
			return 'refused'
		case 'Ambiguous':
			return 'ambiguous'
		case 'Missed':
			return 'missed'
		default:
			throw new JourneyLedgerAbort({
				type: 'JourneyDecodeFailure',
				reason: `Unknown intent status ${status}`,
			})
	}
}

function wakeEvidenceStatus(status: string): 'pending' | 'applied' {
	switch (status) {
		case 'Pending':
			return 'pending'
		case 'Applied':
			return 'applied'
		default:
			throw new JourneyLedgerAbort({
				type: 'JourneyDecodeFailure',
				reason: `Unknown wake status ${status}`,
			})
	}
}

function toJson(input: unknown): string {
	if (typeof input === 'string') return input
	try {
		return JSON.stringify(input)
	} catch (cause) {
		throw new JourneyLedgerAbort({
			type: 'JourneyDecodeFailure',
			reason: `Persisted JSON cannot be encoded: ${errorMessage(cause)}`,
		})
	}
}

function commandReadError(
	cause: unknown,
):
	| Extract<JourneyCommandError, { type: 'JourneyDecodeFailure' }>
	| { readonly type: 'JourneyCommitUnavailable'; readonly reason: string } {
	const error = abortError(cause)
	if (error?.type === 'JourneyDecodeFailure') return error
	return { type: 'JourneyCommitUnavailable', reason: errorMessage(cause) }
}

function commandError(cause: unknown): JourneyCommandError {
	const error = abortError(cause)
	if (error && isCommandError(error)) return error
	return { type: 'JourneyCommitUnavailable', reason: errorMessage(cause) }
}

function isCommandError(
	error: JourneyCommandError | JourneyQueryError,
): error is JourneyCommandError {
	return (
		error.type !== 'JourneyNotFound' && error.type !== 'JourneyQueryUnavailable'
	)
}

function queryError(cause: unknown): JourneyQueryError {
	const error = abortError(cause)
	if (
		error?.type === 'JourneyNotFound' ||
		error?.type === 'JourneyDecodeFailure'
	) {
		return error
	}
	return { type: 'JourneyQueryUnavailable', reason: errorMessage(cause) }
}

function abortError(
	cause: unknown,
): JourneyCommandError | JourneyQueryError | null {
	return cause instanceof JourneyLedgerAbort ? cause.error : null
}

function jsonDeepEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => jsonDeepEqual(value, right[index]))
		)
	}
	if (
		left === null ||
		right === null ||
		typeof left !== 'object' ||
		typeof right !== 'object'
	) {
		return false
	}
	// SAFETY: both operands passed the non-null object checks above.
	const leftRecord = left as Record<string, unknown>
	const rightRecord = right as Record<string, unknown>
	const leftKeys = Object.keys(leftRecord).sort()
	const rightKeys = Object.keys(rightRecord).sort()
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(
			(key, index) =>
				key === rightKeys[index] &&
				jsonDeepEqual(leftRecord[key], rightRecord[key]),
		)
	)
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause)
}

function isRetryableTransactionRace(cause: unknown): boolean {
	if (!cause || typeof cause !== 'object') return false
	// SAFETY: the guard above proved an object; database errors expose optional codes.
	const candidate = cause as { code?: unknown; errno?: unknown }
	return (
		candidate.code === 'ER_LOCK_DEADLOCK' ||
		candidate.code === 'ER_LOCK_WAIT_TIMEOUT' ||
		candidate.errno === 1213 ||
		candidate.errno === 1205
	)
}
