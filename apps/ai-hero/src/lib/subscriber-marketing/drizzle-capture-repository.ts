import { courseSequenceContactEvent } from '@/db/course-sequence-exhaustion-schema'
import {
	contact,
	contactEvent,
	contactState,
	nextAction,
	providerIdentity,
	sideEffectIntent,
	stateTransition,
} from '@/db/schema'
import { and, asc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm'

import { guid } from '@coursebuilder/utils/guid'

import { createInternalId } from '../internal-id'
import {
	isMysqlDuplicateEntryError,
	withMysqlPrimaryKeyRetry,
} from '../mysql-primary-key-retry'
import type {
	CaptureMarketingRepository,
	LinkedActionRecords,
} from './capture-contact-event'
import {
	COURSE_SEQUENCE_EXHAUSTED_EVENT_TYPE,
	EMAIL_COURSE_ENTRY_PAYLOAD_FORMAT,
	COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
	courseSequenceExhaustionFactKey,
	restoreCourseSequenceExhaustedPayload,
	restoreEmailCourseEntryPayload,
	type CourseSequenceExhaustionCommitRequest,
	type CourseSequenceExhaustionCommitResult,
	type CourseSequenceExhaustionRecords,
	type EmailCourseEntryEventRecord,
} from './course-sequence-exhaustion'
import { emitDrovrShadowFactSafely } from './drovr-shadow-emitter'
import { excludeLearnerFlowCanary } from './learner-flow-canary-exclusion'
import {
	canonicalCompletionForWrite,
	isValuePathIntentCompleted,
} from './value-path-completion'
import {
	COURSE_VALUE_PATH_SLUGS,
	isCourseValuePathIntent,
	type LearnerFlowIntent,
} from './learner-flow-classifier'
import type {
	ContactEventRecord,
	ContactRecord,
	ContactState,
	NextAction,
	ProviderIdentityRecord,
	SideEffectIntent,
	StateTransition,
} from './types'
import {
	scanCompletedValuePathIntentFrontier,
	sortValuePathIntentsByCreatedAt,
	type CompletedValuePathIntentScanArgs,
} from './value-path-intent-scan'

type AiHeroWriteDatabase = any

// ~5k rows of intent payload (metadata/gates included) is ~5MB on the wire,
// far under vtgate's 64MiB gRPC response cap.
const SIDE_EFFECT_INTENT_SCAN_PAGE_SIZE = 5000
// Projected entry rows are small, but still page them so pathological history
// cannot recreate vtgate's 64MiB response failure inside one learner page.
export const LEARNER_FLOW_ENTRY_EVENT_PAGE_SIZE = 5000
// Summary reads keep the joined payload and related-row IN lists bounded.
export const LEARNER_FLOW_RECORD_PAGE_SIZE = 1000

type LearnerFlowSummaryIntent = LearnerFlowIntent

type LearnerFlowSummaryEntryEvent = Pick<
	ContactEventRecord,
	'id' | 'contactId' | 'eventType' | 'providerReference' | 'occurredAt'
>

export type LearnerFlowRecord = {
	contactId: string
	contact?: ContactRecord
	contactState?: ContactState
	intents: SideEffectIntent[]
	entryEvents: ContactEventRecord[]
}

type LearnerFlowSummaryRecord = {
	contactId: string
	contactState?: Pick<ContactState, 'lifecycle' | 'humanReview'>
	intents: LearnerFlowSummaryIntent[]
	entryEvents: LearnerFlowSummaryEntryEvent[]
}

export class DrizzleCaptureMarketingRepository implements CaptureMarketingRepository {
	constructor(private readonly database: AiHeroWriteDatabase) {}

	newId(kind: string) {
		return kind === 'next_action' ||
			kind === 'intent' ||
			kind === 'side_effect_intent'
			? createInternalId()
			: guid()
	}

	async findProviderIdentity(provider: string, externalId: string) {
		const rows = await this.database
			.select()
			.from(providerIdentity)
			.where(
				and(
					eq(providerIdentity.provider, provider),
					eq(providerIdentity.externalId, externalId),
				),
			)
			.limit(1)
		return rows[0] ? toProviderIdentityRecord(rows[0]) : undefined
	}

	async findContactById(id: string) {
		const rows = await this.database
			.select()
			.from(contact)
			.where(eq(contact.id, id))
			.limit(1)
		return rows[0] ? toContactRecord(rows[0]) : undefined
	}

	async findContactByEmail(email: string) {
		const rows = await this.database
			.select()
			.from(contact)
			.where(eq(contact.email, email))
			.limit(1)
		return rows[0] ? toContactRecord(rows[0]) : undefined
	}

	async findContactByUserId(userId: string) {
		const rows = await this.database
			.select()
			.from(contact)
			.where(eq(contact.userId, userId))
			.limit(1)
		return rows[0] ? toContactRecord(rows[0]) : undefined
	}

	async createContact(input: Omit<ContactRecord, 'id'>) {
		const record: ContactRecord = { id: this.newId('contact'), ...input }
		await this.database.insert(contact).values({
			...record,
			createdAt: new Date(record.createdAt),
			updatedAt: new Date(record.updatedAt),
		})
		return record
	}

	async updateContactOptInAttribution(
		contactId: string,
		attribution: NonNullable<ContactRecord['optInAttribution']>,
	) {
		const current = await this.findContactById(contactId)
		if (!current) throw new Error(`Missing contact ${contactId}`)
		if (!current.optInAttribution) {
			await this.database
				.update(contact)
				.set({ optInAttribution: attribution, updatedAt: new Date() })
				.where(eq(contact.id, contactId))
		}
		return {
			...current,
			optInAttribution: current.optInAttribution ?? attribution,
		}
	}

	async createProviderIdentity(input: Omit<ProviderIdentityRecord, 'id'>) {
		const record: ProviderIdentityRecord = {
			id: this.newId('provider_identity'),
			...input,
		}
		await this.database.insert(providerIdentity).values({
			...record,
			createdAt: new Date(record.createdAt),
			updatedAt: new Date(record.updatedAt),
		})
		return record
	}

	async linkProviderIdentityToContact(identityId: string, contactId: string) {
		await this.database
			.update(providerIdentity)
			.set({ contactId, updatedAt: new Date() })
			.where(eq(providerIdentity.id, identityId))
		const identity = await this.findProviderIdentityById(identityId)
		if (!identity) throw new Error(`Missing provider identity ${identityId}`)
		return identity
	}

	async findContactEventBySemanticKey(key: string) {
		const rows = await this.database
			.select()
			.from(contactEvent)
			.where(eq(contactEvent.semanticIdempotencyKey, key))
			.limit(1)
		return rows[0] ? toContactEventRecord(rows[0]) : undefined
	}

	async findContactEventsByType(contactId: string, eventType: string) {
		const rows = await this.database
			.select()
			.from(contactEvent)
			.where(
				and(
					eq(contactEvent.contactId, contactId),
					eq(contactEvent.eventType, eventType),
				),
			)
		return rows.map(toContactEventRecord)
	}

	async createContactEvent(
		input: Omit<ContactEventRecord, 'id' | 'createdAt'> & {
			createdAt?: string
		},
	) {
		const record: ContactEventRecord = {
			id: this.newId('contact_event'),
			createdAt: input.createdAt ?? new Date().toISOString(),
			...input,
		}
		try {
			await this.database.insert(contactEvent).values({
				...record,
				occurredAt: new Date(record.occurredAt),
				createdAt: new Date(record.createdAt),
			})
			emitDrovrShadowFactSafely({ kind: 'contact-event', event: record })
			return record
		} catch (cause) {
			// The semantic key is the durable replay boundary. A concurrent or
			// retried insert may lose the race after the preflight read. If the row
			// now exists, the requested fact is already recorded and the caller can
			// safely continue from it. Any other insert failure still escapes.
			const existing = await this.findContactEventBySemanticKey(
				record.semanticIdempotencyKey,
			)
			if (existing) return existing
			throw cause
		}
	}

	async createEmailCourseEntryEvent(
		input: Omit<EmailCourseEntryEventRecord, 'id' | 'createdAt'> & {
			createdAt?: string
		},
	) {
		const record: EmailCourseEntryEventRecord = {
			id: this.newId('contact_event'),
			createdAt: input.createdAt ?? new Date().toISOString(),
			...input,
		}
		try {
			await this.database.insert(courseSequenceContactEvent).values({
				...record,
				occurredAt: new Date(record.occurredAt),
				createdAt: new Date(record.createdAt),
			})
			return record
		} catch (cause) {
			if (!isMysqlDuplicateEntryError(cause)) throw cause
			const rows = await this.database
				.select()
				.from(courseSequenceContactEvent)
				.where(
					eq(
						courseSequenceContactEvent.semanticIdempotencyKey,
						record.semanticIdempotencyKey,
					),
				)
				.limit(1)
			const existing = rows[0]
			const restored = existing
				? restoreEmailCourseEntryPayload(existing.domainPayload)
				: undefined
			if (
				!existing ||
				!restored ||
				existing.payloadFormat !== record.payloadFormat ||
				JSON.stringify(restored) !== JSON.stringify(record.domainPayload)
			) {
				throw cause
			}
			return toEmailCourseEntryEventRecord(existing, restored)
		}
	}

	async findCurrentContactState(contactId: string) {
		const rows = await this.database
			.select()
			.from(contactState)
			.where(eq(contactState.contactId, contactId))
			.limit(1)
		return rows[0] ? toContactStateRecord(rows[0]) : undefined
	}

	async upsertContactState(state: ContactState) {
		const existing = await this.findCurrentContactState(state.contactId)
		const values = {
			...state,
			confidence: state.confidence.toString(),
			updatedAt: new Date(state.updatedAt),
		}
		if (existing) {
			await this.database
				.update(contactState)
				.set(values)
				.where(eq(contactState.id, existing.id))
		} else {
			await this.database.insert(contactState).values(values)
		}
		return state
	}

	async createStateTransition(input: Omit<StateTransition, 'id'>) {
		const record: StateTransition = {
			id: this.newId('state_transition'),
			...input,
		}
		await this.database.insert(stateTransition).values({
			...record,
			createdAt: new Date(record.createdAt),
		})
		return record
	}

	async createNextAction(input: NextAction) {
		return withMysqlPrimaryKeyRetry(async (attempt) => {
			const record =
				attempt === 0 ? input : { ...input, id: createInternalId() }
			await this.database.insert(nextAction).values({
				...record,
				createdAt: new Date(record.createdAt),
			})
			return record
		})
	}

	async createNextActionWithSideEffectIntents(
		createRecords: () => LinkedActionRecords,
	) {
		return withMysqlPrimaryKeyRetry(async () => {
			const records = createRecords()
			await this.database.transaction(
				async (transaction: AiHeroWriteDatabase) => {
					await transaction.insert(nextAction).values({
						...records.nextAction,
						createdAt: new Date(records.nextAction.createdAt),
					})
					for (const input of records.sideEffectIntents) {
						const completedAt = canonicalCompletionForWrite(input)
						await transaction.insert(sideEffectIntent).values({
							...input,
							completedAt: completedAt ? new Date(completedAt) : null,
							createdAt: new Date(input.createdAt),
						})
					}
				},
			)
			return records
		})
	}

	async commitCourseSequenceExhaustion(
		request: CourseSequenceExhaustionCommitRequest,
	): Promise<CourseSequenceExhaustionCommitResult> {
		try {
			return await this.database.transaction(
				async (transaction: AiHeroWriteDatabase) => {
					await validateSequenceExhaustionSource(transaction, request)
					const existing = await readSequenceExhaustionPair(
						transaction,
						request,
					)
					if (existing) return existing

					const { fact, nextAction: action, terminalIntent } = request.records
					await transaction.insert(courseSequenceContactEvent).values({
						...fact,
						occurredAt: new Date(fact.occurredAt),
						createdAt: new Date(fact.createdAt),
					})
					await transaction.insert(nextAction).values({
						...action,
						createdAt: new Date(action.createdAt),
					})
					await transaction.insert(sideEffectIntent).values({
						...terminalIntent,
						completedAt: null,
						createdAt: new Date(terminalIntent.createdAt),
					})
					return { status: 'committed' as const, records: request.records }
				},
			)
		} catch (cause) {
			if (!isMysqlDuplicateEntryError(cause)) throw cause
			const replay = await readSequenceExhaustionPair(this.database, request)
			if (replay) return replay
			throw cause
		}
	}

	async findSideEffectIntentByIdempotencyKey(idempotencyKey: string) {
		const rows = await this.database
			.select()
			.from(sideEffectIntent)
			.where(eq(sideEffectIntent.idempotencyKey, idempotencyKey))
			.limit(1)
		return rows[0] ? toSideEffectIntentRecord(rows[0]) : undefined
	}

	async createSideEffectIntent(input: SideEffectIntent) {
		return withMysqlPrimaryKeyRetry(async (attempt) => {
			const retriedInput =
				attempt === 0 ? input : { ...input, id: createInternalId() }
			const completedAt = canonicalCompletionForWrite(retriedInput)
			const record = { ...retriedInput, completedAt }
			await this.database.insert(sideEffectIntent).values({
				...record,
				completedAt: completedAt ? new Date(completedAt) : null,
				createdAt: new Date(retriedInput.createdAt),
			})
			return record
		})
	}

	async findPendingValuePathEmailSideEffectIntents(args: {
		limit: number
		intentIds?: string[]
	}) {
		// Only pending rows and failed-retryable rows can ever be due; completed
		// rows (the vast majority) never survive the filter below, so exclude
		// them in SQL instead of fetching and discarding them every poll.
		const rows = await this.database
			.select()
			.from(sideEffectIntent)
			.where(
				and(
					eq(sideEffectIntent.provider, 'kit'),
					eq(sideEffectIntent.type, 'send-value-path-email'),
					inArray(sideEffectIntent.status, ['pending', 'failed']),
				),
			)
		const now = new Date().toISOString()
		const requestedIntentIds = args.intentIds
			? new Set(args.intentIds)
			: undefined
		const due = rows
			.map(toSideEffectIntentRecord)
			.filter(
				(intent: SideEffectIntent) =>
					!isValuePathIntentCompleted(intent) &&
					(intent.status === 'pending' || isDueRetryableIntent(intent, now)) &&
					(!requestedIntentIds || requestedIntentIds.has(intent.id)),
			)
		return sortValuePathIntentsByCreatedAt(due).slice(0, args.limit)
	}

	async findCompletedValuePathEmailSideEffectIntentScan(
		args: Omit<CompletedValuePathIntentScanArgs, 'intents'>,
	) {
		const records = await this.findValuePathEmailSideEffectIntentsForScan()
		// Reduce to each contact/path frontier after applying the authorization
		// and asset scope, then apply the limit. Scope-after-limit starved rolling
		// enrollments on 2026-07-17 when the original activation cohort crowded
		// out the live public cohort.
		return scanCompletedValuePathIntentFrontier({ ...args, intents: records })
	}

	async findCompletedValuePathEmailSideEffectIntents(
		args: Omit<CompletedValuePathIntentScanArgs, 'intents'>,
	) {
		return (await this.findCompletedValuePathEmailSideEffectIntentScan(args))
			.intents
	}

	async findValuePathEmailSideEffectIntentsForScan() {
		// The scan must see completed rows (frontier semantics, 2026-07-17), but
		// the unbounded single result crossed vtgate's 64MiB gRPC response cap on
		// 2026-08-12 (ResourceExhausted). Page by primary key so each response
		// stays small no matter how many intents accumulate.
		const rows = await this.selectValuePathIntentRowsPaged()
		return rows.map(toSideEffectIntentRecord)
	}

	// Keyset-paged full read of kit/send-value-path-email intent rows. Every
	// full read of this set must go through here — a single unbounded select
	// crossed vtgate's 64MiB gRPC response cap on 2026-08-12.
	private async selectValuePathIntentRowsPaged(extraCondition?: SQL) {
		const collected: any[] = []
		let cursor: string | undefined
		for (;;) {
			const rows = await this.database
				.select()
				.from(sideEffectIntent)
				.where(
					and(
						eq(sideEffectIntent.provider, 'kit'),
						eq(sideEffectIntent.type, 'send-value-path-email'),
						extraCondition,
						cursor === undefined ? undefined : gt(sideEffectIntent.id, cursor),
					),
				)
				.orderBy(asc(sideEffectIntent.id))
				.limit(SIDE_EFFECT_INTENT_SCAN_PAGE_SIZE)
			collected.push(...rows)
			if (rows.length < SIDE_EFFECT_INTENT_SCAN_PAGE_SIZE) {
				return collected
			}
			cursor = rows[rows.length - 1].id
		}
	}

	async findCompletedValuePathEmailSideEffectIntentsForRepair() {
		return (await this.findValuePathEmailSideEffectIntentsForScan()).filter(
			(intent: SideEffectIntent) =>
				intent.status === 'completed' || isValuePathIntentCompleted(intent),
		)
	}

	async findValuePathEmailSideEffectIntentsByContact(contactId: string) {
		const rows = await this.database
			.select()
			.from(sideEffectIntent)
			.where(
				and(
					eq(sideEffectIntent.contactId, contactId),
					eq(sideEffectIntent.provider, 'kit'),
					eq(sideEffectIntent.type, 'send-value-path-email'),
				),
			)
		return sortValuePathIntentsByCreatedAt(rows.map(toSideEffectIntentRecord))
	}

	/**
	 * Bounded learner-flow pages for aggregate callers. First collect an ordered,
	 * deduplicated ID list, then hydrate fixed pages. This prevents cursor drift
	 * and duplicate IDs; it is not a transactional database snapshot.
	 */
	async *findSkillsWorkflowLearnerFlowRecordPages(options?: {
		includeCanary?: boolean
	}): AsyncGenerator<LearnerFlowSummaryRecord[]> {
		const contactIds =
			await this.findSkillsWorkflowLearnerFlowContactIds(options)
		for (
			let offset = 0;
			offset < contactIds.length;
			offset += LEARNER_FLOW_RECORD_PAGE_SIZE
		) {
			yield await this.findSkillsWorkflowLearnerFlowRecordsByContactIds(
				contactIds.slice(offset, offset + LEARNER_FLOW_RECORD_PAGE_SIZE),
			)
		}
	}

	private async findSkillsWorkflowLearnerFlowContactIds(options?: {
		includeCanary?: boolean
	}) {
		const contactIds: string[] = []
		let cursor: string | undefined
		for (;;) {
			const intentContactIds = this.database
				.selectDistinct({ contactId: sideEffectIntent.contactId })
				.from(sideEffectIntent)
				.where(
					and(
						eq(sideEffectIntent.provider, 'kit'),
						eq(sideEffectIntent.type, 'send-value-path-email'),
						options?.includeCanary
							? undefined
							: excludeLearnerFlowCanary({
									contactId: sideEffectIntent.contactId,
								}),
					),
				)
			const entryContactIds = this.database
				.selectDistinct({ contactId: contactEvent.contactId })
				.from(contactEvent)
				.where(
					and(
						eq(contactEvent.eventType, 'value-path.entered'),
						inArray(
							contactEvent.providerReference,
							COURSE_VALUE_PATH_SLUGS.map((path) => `value-path:${path}`),
						),
						options?.includeCanary
							? undefined
							: excludeLearnerFlowCanary({ contactId: contactEvent.contactId }),
					),
				)
			const learnerIds = intentContactIds
				.union(entryContactIds)
				.as('learner_ids')
			const idRows = await this.database
				.select({ contactId: learnerIds.contactId })
				.from(learnerIds)
				.where(
					cursor === undefined ? undefined : gt(learnerIds.contactId, cursor),
				)
				.orderBy(asc(learnerIds.contactId))
				.limit(LEARNER_FLOW_RECORD_PAGE_SIZE)
			const page = idRows.map((row: { contactId: string }) => row.contactId)
			contactIds.push(...page)
			if (page.length < LEARNER_FLOW_RECORD_PAGE_SIZE) return contactIds
			cursor = page[page.length - 1]
		}
	}

	/** Read-only course-path scan for the detailed learner-flow operator. */
	async findSkillsWorkflowLearnerFlowRecords(options?: {
		includeCanary?: boolean
	}): Promise<LearnerFlowRecord[]> {
		const [intentRows, entryEventRows]: [any[], any[]] = await Promise.all([
			this.selectValuePathIntentRowsPaged(
				options?.includeCanary
					? undefined
					: excludeLearnerFlowCanary({
							contactId: sideEffectIntent.contactId,
						}),
			),
			this.database
				.select()
				.from(contactEvent)
				.where(
					and(
						eq(contactEvent.eventType, 'value-path.entered'),
						inArray(
							contactEvent.providerReference,
							COURSE_VALUE_PATH_SLUGS.map((path) => `value-path:${path}`),
						),
						options?.includeCanary
							? undefined
							: excludeLearnerFlowCanary({
									contactId: contactEvent.contactId,
								}),
					),
				),
		])
		const learnerIntents = intentRows
			.map(toSideEffectIntentRecord)
			.filter(isCourseValuePathIntent)
		const entryEvents = entryEventRows.map(toContactEventRecord)
		const contactIds: string[] = Array.from(
			new Set([
				...learnerIntents.map((intent) => intent.contactId),
				...entryEvents.map((event) => event.contactId),
			]),
		)
		if (contactIds.length === 0) return []

		const [contacts, states]: [any[], any[]] = await Promise.all([
			this.database
				.select()
				.from(contact)
				.where(inArray(contact.id, contactIds)),
			this.database
				.select()
				.from(contactState)
				.where(inArray(contactState.contactId, contactIds)),
		])
		return assembleLearnerFlowRecords({
			contactIds,
			intentRows,
			entryEventRows,
			contacts,
			states,
		})
	}

	private async findSkillsWorkflowLearnerFlowRecordsByContactIds(
		contactIds: string[],
	): Promise<LearnerFlowSummaryRecord[]> {
		if (contactIds.length === 0) return []
		const [intentRows, entryEventRows, states]: [any[], any[], any[]] =
			await Promise.all([
				this.selectLearnerFlowIntentRowsPaged(contactIds),
				this.selectLearnerFlowEntryEventRowsPaged(contactIds),
				this.database
					.select({
						contactId: contactState.contactId,
						lifecycle: contactState.lifecycle,
						humanReview: contactState.humanReview,
					})
					.from(contactState)
					.where(inArray(contactState.contactId, contactIds)),
			])
		return assembleLearnerFlowSummaryRecords({
			contactIds,
			intentRows,
			entryEventRows,
			states,
		})
	}

	private async selectLearnerFlowIntentRowsPaged(contactIds: string[]) {
		const collected: any[] = []
		let cursor: string | undefined
		for (;;) {
			const rows = await this.database
				.select({
					id: sideEffectIntent.id,
					contactId: sideEffectIntent.contactId,
					provider: sideEffectIntent.provider,
					type: sideEffectIntent.type,
					status: sideEffectIntent.status,
					completedAt: sideEffectIntent.completedAt,
					reviewReasons: sideEffectIntent.reviewReasons,
					valuePathSlug: jsonString(
						sideEffectIntent.metadata,
						'$.valuePathSlug',
					),
					emailResourceId: jsonString(
						sideEffectIntent.metadata,
						'$.emailResourceId',
					),
					metadataCompletedAt: jsonString(
						sideEffectIntent.metadata,
						'$.completedAt',
					),
					learnerFlowCanary: jsonBoolean(
						sideEffectIntent.metadata,
						'$.learnerFlowCanary',
					),
					learnerFlowCanaryCadenceHours: jsonNumber(
						sideEffectIntent.metadata,
						'$.learnerFlowCanaryCadenceHours',
					),
					learnerFlowFixture: jsonBoolean(
						sideEffectIntent.metadata,
						'$.learnerFlowFixture',
					),
					learnerFlowFixtureStatus: jsonString(
						sideEffectIntent.metadata,
						'$.learnerFlowFixtureStatus',
					),
					retryable: jsonBoolean(sideEffectIntent.metadata, '$.retryable'),
					retryAttemptCount: jsonNumber(
						sideEffectIntent.metadata,
						'$.retryAttemptCount',
					),
					maxRetryAttempts: jsonNumber(
						sideEffectIntent.metadata,
						'$.maxRetryAttempts',
					),
					retryReason: jsonString(sideEffectIntent.metadata, '$.retryReason'),
					bounced: jsonBoolean(sideEffectIntent.metadata, '$.bounced'),
					complained: jsonBoolean(sideEffectIntent.metadata, '$.complained'),
					unsubscribed: jsonBoolean(
						sideEffectIntent.metadata,
						'$.unsubscribed',
					),
					providerResultBounced: jsonBoolean(
						sideEffectIntent.metadata,
						'$.providerResult.bounced',
					),
					providerResultComplained: jsonBoolean(
						sideEffectIntent.metadata,
						'$.providerResult.complained',
					),
					providerResultUnsubscribed: jsonBoolean(
						sideEffectIntent.metadata,
						'$.providerResult.unsubscribed',
					),
					createdAt: sideEffectIntent.createdAt,
				})
				.from(sideEffectIntent)
				.where(
					and(
						inArray(sideEffectIntent.contactId, contactIds),
						eq(sideEffectIntent.provider, 'kit'),
						eq(sideEffectIntent.type, 'send-value-path-email'),
						cursor === undefined ? undefined : gt(sideEffectIntent.id, cursor),
					),
				)
				.orderBy(asc(sideEffectIntent.id))
				.limit(SIDE_EFFECT_INTENT_SCAN_PAGE_SIZE)
			collected.push(...rows)
			if (rows.length < SIDE_EFFECT_INTENT_SCAN_PAGE_SIZE) return collected
			cursor = rows[rows.length - 1].id
		}
	}

	private async selectLearnerFlowEntryEventRowsPaged(contactIds: string[]) {
		const collected: any[] = []
		let cursor: string | undefined
		for (;;) {
			const rows = await this.database
				.select({
					id: contactEvent.id,
					contactId: contactEvent.contactId,
					eventType: contactEvent.eventType,
					providerReference: contactEvent.providerReference,
					occurredAt: contactEvent.occurredAt,
				})
				.from(contactEvent)
				.where(
					and(
						inArray(contactEvent.contactId, contactIds),
						eq(contactEvent.eventType, 'value-path.entered'),
						inArray(
							contactEvent.providerReference,
							COURSE_VALUE_PATH_SLUGS.map((path) => `value-path:${path}`),
						),
						cursor === undefined ? undefined : gt(contactEvent.id, cursor),
					),
				)
				.orderBy(asc(contactEvent.id))
				.limit(LEARNER_FLOW_ENTRY_EVENT_PAGE_SIZE)
			collected.push(...rows)
			if (rows.length < LEARNER_FLOW_ENTRY_EVENT_PAGE_SIZE) return collected
			cursor = rows[rows.length - 1].id
		}
	}

	async updateSideEffectIntent(
		id: string,
		patch: Pick<
			SideEffectIntent,
			'status' | 'gates' | 'reviewReasons' | 'metadata'
		> &
			Pick<SideEffectIntent, 'completedAt'>,
	) {
		const completedAt = canonicalCompletionForWrite(patch)
		await this.database
			.update(sideEffectIntent)
			.set({
				...patch,
				completedAt: completedAt ? new Date(completedAt) : null,
			})
			.where(eq(sideEffectIntent.id, id))
		const rows = await this.database
			.select()
			.from(sideEffectIntent)
			.where(eq(sideEffectIntent.id, id))
			.limit(1)
		if (!rows[0]) throw new Error(`Missing side effect intent ${id}`)
		return toSideEffectIntentRecord(rows[0])
	}

	private async findProviderIdentityById(identityId: string) {
		const rows = await this.database
			.select()
			.from(providerIdentity)
			.where(eq(providerIdentity.id, identityId))
			.limit(1)
		return rows[0] ? toProviderIdentityRecord(rows[0]) : undefined
	}
}

function assembleLearnerFlowSummaryRecords(args: {
	contactIds: string[]
	intentRows: any[]
	entryEventRows: any[]
	states: any[]
}): LearnerFlowSummaryRecord[] {
	const intents = args.intentRows
		.map(toLearnerFlowSummaryIntent)
		.filter(isCourseValuePathIntent)
	const entryEvents = args.entryEventRows.map(toLearnerFlowSummaryEntryEvent)
	const statesByContactId = new Map<
		string,
		Pick<ContactState, 'lifecycle' | 'humanReview'>
	>(
		args.states.map((record) => [
			record.contactId,
			{ lifecycle: record.lifecycle, humanReview: Boolean(record.humanReview) },
		]),
	)
	const intentsByContactId = new Map<string, LearnerFlowSummaryIntent[]>()
	for (const intent of intents) {
		const current = intentsByContactId.get(intent.contactId) ?? []
		current.push(intent)
		intentsByContactId.set(intent.contactId, current)
	}
	const entryEventsByContactId = new Map<
		string,
		LearnerFlowSummaryEntryEvent[]
	>()
	for (const event of entryEvents) {
		const current = entryEventsByContactId.get(event.contactId) ?? []
		current.push(event)
		entryEventsByContactId.set(event.contactId, current)
	}
	return args.contactIds
		.map((contactId) => ({
			contactId,
			contactState: statesByContactId.get(contactId),
			intents: [...(intentsByContactId.get(contactId) ?? [])].sort(
				(left, right) =>
					left.createdAt.localeCompare(right.createdAt) ||
					left.id.localeCompare(right.id),
			),
			entryEvents: entryEventsByContactId.get(contactId) ?? [],
		}))
		.filter(
			(record) => record.intents.length > 0 || record.entryEvents.length > 0,
		)
}

function assembleLearnerFlowRecords(args: {
	contactIds: string[]
	intentRows: any[]
	entryEventRows: any[]
	contacts: any[]
	states: any[]
}): LearnerFlowRecord[] {
	const intents = args.intentRows
		.map(toSideEffectIntentRecord)
		.filter(isCourseValuePathIntent)
	const entryEvents = args.entryEventRows.map(toContactEventRecord)
	const contactsById = new Map<string, ContactRecord>(
		args.contacts.map((record) => [record.id, toContactRecord(record)]),
	)
	const statesByContactId = new Map<string, ContactState>(
		args.states.map((record) => [
			record.contactId,
			toContactStateRecord(record),
		]),
	)
	const intentsByContactId = new Map<string, SideEffectIntent[]>()
	for (const intent of intents) {
		const current = intentsByContactId.get(intent.contactId) ?? []
		current.push(intent)
		intentsByContactId.set(intent.contactId, current)
	}
	const entryEventsByContactId = new Map<string, ContactEventRecord[]>()
	for (const event of entryEvents) {
		const current = entryEventsByContactId.get(event.contactId) ?? []
		current.push(event)
		entryEventsByContactId.set(event.contactId, current)
	}
	return args.contactIds
		.map((contactId) => ({
			contactId,
			contact: contactsById.get(contactId),
			contactState: statesByContactId.get(contactId),
			intents: sortValuePathIntentsByCreatedAt(
				intentsByContactId.get(contactId) ?? [],
			),
			entryEvents: entryEventsByContactId.get(contactId) ?? [],
		}))
		.filter(
			(record) => record.intents.length > 0 || record.entryEvents.length > 0,
		)
}

function toLearnerFlowSummaryIntent(row: any): LearnerFlowSummaryIntent {
	const providerResult = compactDefined({
		bounced: toJsonBoolean(row.providerResultBounced),
		complained: toJsonBoolean(row.providerResultComplained),
		unsubscribed: toJsonBoolean(row.providerResultUnsubscribed),
	})
	return {
		id: row.id,
		contactId: row.contactId,
		provider: row.provider,
		type: row.type,
		status: row.status,
		completedAt: row.completedAt ? toIso(row.completedAt) : null,
		reviewReasons: row.reviewReasons,
		metadata: compactDefined({
			valuePathSlug: toJsonString(row.valuePathSlug),
			emailResourceId: toJsonString(row.emailResourceId),
			completedAt: toJsonString(row.metadataCompletedAt),
			learnerFlowCanary: toJsonBoolean(row.learnerFlowCanary),
			learnerFlowCanaryCadenceHours: toJsonNumber(
				row.learnerFlowCanaryCadenceHours,
			),
			learnerFlowFixture: toJsonBoolean(row.learnerFlowFixture),
			learnerFlowFixtureStatus: toJsonString(row.learnerFlowFixtureStatus),
			retryable: toJsonBoolean(row.retryable),
			retryAttemptCount: toJsonNumber(row.retryAttemptCount),
			maxRetryAttempts: toJsonNumber(row.maxRetryAttempts),
			retryReason: toJsonString(row.retryReason),
			bounced: toJsonBoolean(row.bounced),
			complained: toJsonBoolean(row.complained),
			unsubscribed: toJsonBoolean(row.unsubscribed),
			providerResult:
				Object.keys(providerResult).length > 0 ? providerResult : undefined,
		}),
		createdAt: toIso(row.createdAt),
	}
}

function toLearnerFlowSummaryEntryEvent(
	row: any,
): LearnerFlowSummaryEntryEvent {
	return {
		id: row.id,
		contactId: row.contactId,
		eventType: row.eventType,
		providerReference: row.providerReference,
		occurredAt: toIso(row.occurredAt),
	}
}

function toContactRecord(row: any): ContactRecord {
	return {
		id: row.id,
		userId: row.userId,
		email: row.email,
		name: row.name,
		lifecycle: row.lifecycle,
		isProvisional: Boolean(row.isProvisional),
		optInAttribution: row.optInAttribution ?? null,
		createdAt: toIso(row.createdAt),
		updatedAt: toIso(row.updatedAt),
	}
}

async function validateSequenceExhaustionSource(
	database: AiHeroWriteDatabase,
	request: CourseSequenceExhaustionCommitRequest,
) {
	const sourceRows = await database
		.select()
		.from(sideEffectIntent)
		.where(eq(sideEffectIntent.id, request.sourceIntentId))
		.limit(1)
	const entryRows = await database
		.select()
		.from(courseSequenceContactEvent)
		.where(eq(courseSequenceContactEvent.id, request.courseEntryEventId))
		.limit(1)
	const source = sourceRows[0]
	const entry = entryRows[0]
	const payload = restoreCourseSequenceExhaustedPayload(
		request.records.fact.domainPayload,
	)
	const entryPayload = restoreEmailCourseEntryPayload(entry?.domainPayload)
	if (!source || !entry || !payload) {
		throw new Error('Sequence exhaustion source evidence is missing or invalid')
	}
	const sourceRecord = toSideEffectIntentRecord(source)
	if (
		sourceRecord.id !== request.sourceIntentId ||
		sourceRecord.id !== payload.progression.from.intentId ||
		sourceRecord.status !== 'completed' ||
		!sourceRecord.completedAt ||
		sourceRecord.contactId !== payload.actor.contactId ||
		sourceRecord.contactId !== request.records.fact.contactId ||
		stringValue(sourceRecord.metadata.valuePathSlug) !==
			payload.actor.valuePathId ||
		stringValue(sourceRecord.metadata.emailResourceId) !==
			payload.progression.from.emailResourceId ||
		sourceRecord.idempotencyKey !== payload.progression.from.idempotencyKey ||
		sourceRecord.completedAt !== payload.progression.from.completedAt ||
		entry.id !== request.courseEntryEventId ||
		entry.id !== payload.actor.courseEntryEventId ||
		entry.contactId !== payload.actor.contactId ||
		entry.eventType !== 'value-path.entered' ||
		(entryPayload
			? entryPayload.valuePathId !== payload.actor.valuePathId ||
				JSON.stringify(entryPayload.deadlineTimeZone) !==
					JSON.stringify(payload.deadlineTimeZone)
			: payload.deadlineTimeZone.type !== 'ExplicitFallback' ||
				payload.deadlineTimeZone.reason !== 'legacy-entry') ||
		request.records.fact.provider !== 'ai-hero' ||
		request.records.fact.contactId !== payload.actor.contactId ||
		request.records.fact.providerReference !==
			`value-path:${payload.actor.valuePathId}` ||
		request.records.fact.occurredAt !== payload.exhaustedAt ||
		request.records.fact.eventType !== COURSE_SEQUENCE_EXHAUSTED_EVENT_TYPE ||
		request.records.fact.domainFactKey !==
			courseSequenceExhaustionFactKey({
				contactId: payload.actor.contactId,
				valuePathId: payload.actor.valuePathId,
			}) ||
		request.records.fact.semanticIdempotencyKey !==
			request.records.fact.domainFactKey ||
		request.records.fact.payloadFormat !==
			COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT ||
		request.records.nextAction.id !==
			payload.progression.terminal.nextActionId ||
		request.records.nextAction.eventId !== request.records.fact.id ||
		request.records.nextAction.contactId !== payload.actor.contactId ||
		request.records.nextAction.type !== 'advance-value-path' ||
		request.records.nextAction.status !== 'planned' ||
		request.records.terminalIntent.nextActionId !==
			request.records.nextAction.id ||
		request.records.terminalIntent.contactId !== payload.actor.contactId ||
		request.records.terminalIntent.provider !== 'kit' ||
		request.records.terminalIntent.type !== 'send-value-path-email' ||
		request.records.terminalIntent.status !== 'pending' ||
		request.records.terminalIntent.id !==
			payload.progression.terminal.intentId ||
		request.records.terminalIntent.idempotencyKey !==
			payload.progression.terminal.idempotencyKey ||
		stringValue(request.records.terminalIntent.metadata.valuePathSlug) !==
			payload.actor.valuePathId ||
		stringValue(request.records.terminalIntent.metadata.emailResourceId) !==
			payload.progression.terminal.emailResourceId ||
		stringValue(
			request.records.terminalIntent.metadata.sequenceExhaustionFactId,
		) !== request.records.fact.id
	) {
		throw new Error(
			'Sequence exhaustion source evidence does not own the commit',
		)
	}
}

async function readSequenceExhaustionPair(
	database: AiHeroWriteDatabase,
	request: CourseSequenceExhaustionCommitRequest,
): Promise<CourseSequenceExhaustionCommitResult | undefined> {
	const factRows = await database
		.select()
		.from(courseSequenceContactEvent)
		.where(
			eq(
				courseSequenceContactEvent.domainFactKey,
				request.records.fact.domainFactKey,
			),
		)
		.limit(1)
	const intentRows = await database
		.select()
		.from(sideEffectIntent)
		.where(
			eq(
				sideEffectIntent.idempotencyKey,
				request.records.terminalIntent.idempotencyKey,
			),
		)
		.limit(1)
	const factRow = factRows[0]
	const intentRow = intentRows[0]
	if (!factRow && !intentRow) return undefined
	if (!factRow && intentRow) {
		return {
			status: 'legacy-terminal-intent-without-fact',
			terminalIntentId: intentRow.id,
		}
	}
	if (factRow && !intentRow) {
		throw new Error('Sequence exhaustion fact exists without terminal intent')
	}
	const payload = restoreCourseSequenceExhaustedPayload(factRow.domainPayload)
	const intent = toSideEffectIntentRecord(intentRow)
	if (
		!payload ||
		factRow.payloadFormat !== COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT ||
		factRow.eventType !== COURSE_SEQUENCE_EXHAUSTED_EVENT_TYPE ||
		factRow.provider !== 'ai-hero' ||
		factRow.contactId !== request.records.fact.contactId ||
		factRow.contactId !== payload.actor.contactId ||
		factRow.providerReference !== `value-path:${payload.actor.valuePathId}` ||
		toIso(factRow.occurredAt) !== payload.exhaustedAt ||
		factRow.domainFactKey !==
			courseSequenceExhaustionFactKey({
				contactId: payload.actor.contactId,
				valuePathId: payload.actor.valuePathId,
			}) ||
		payload.progression.terminal.intentId !== intent.id ||
		payload.progression.terminal.idempotencyKey !== intent.idempotencyKey ||
		payload.progression.terminal.nextActionId !== intent.nextActionId ||
		intent.contactId !== payload.actor.contactId ||
		stringValue(intent.metadata.sequenceExhaustionFactId) !== factRow.id ||
		stringValue(intent.metadata.valuePathSlug) !== payload.actor.valuePathId ||
		stringValue(intent.metadata.emailResourceId) !==
			payload.progression.terminal.emailResourceId
	) {
		throw new Error('Stored sequence exhaustion pair is corrupt or mismatched')
	}
	const actionRows = await database
		.select()
		.from(nextAction)
		.where(eq(nextAction.id, intent.nextActionId))
		.limit(1)
	const action = actionRows[0]
	if (
		!action ||
		action.id !== payload.progression.terminal.nextActionId ||
		action.eventId !== factRow.id ||
		action.contactId !== payload.actor.contactId ||
		action.type !== 'advance-value-path' ||
		action.status !== 'planned' ||
		intent.provider !== 'kit' ||
		intent.type !== 'send-value-path-email' ||
		!isSequenceExhaustionIntentStatus(intent.status)
	) {
		throw new Error(
			'Stored sequence exhaustion action is missing or mismatched',
		)
	}
	return {
		status: 'replayed',
		records: {
			fact: {
				...toContactEventRecord(factRow),
				provider: 'ai-hero',
				eventType: COURSE_SEQUENCE_EXHAUSTED_EVENT_TYPE,
				domainFactKey: factRow.domainFactKey,
				payloadFormat: COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
				domainPayload: payload,
			},
			nextAction: {
				id: action.id,
				contactId: action.contactId,
				contactStateId: action.contactStateId,
				eventId: action.eventId,
				type: action.type,
				status: action.status,
				gates: action.gates,
				reviewReasons: action.reviewReasons,
				rationale: action.rationale,
				createdAt: toIso(action.createdAt),
			},
			terminalIntent: {
				...intent,
				provider: 'kit',
				type: 'send-value-path-email',
			},
		},
	}
}

function toProviderIdentityRecord(row: any): ProviderIdentityRecord {
	return {
		id: row.id,
		contactId: row.contactId,
		provider: row.provider,
		externalId: row.externalId,
		evidence: row.evidence,
		createdAt: toIso(row.createdAt),
		updatedAt: toIso(row.updatedAt),
	}
}

function toEmailCourseEntryEventRecord(
	row: any,
	domainPayload: EmailCourseEntryEventRecord['domainPayload'],
): EmailCourseEntryEventRecord {
	return {
		...toContactEventRecord(row),
		eventType: 'value-path.entered',
		payloadFormat: EMAIL_COURSE_ENTRY_PAYLOAD_FORMAT,
		domainPayload,
	}
}

function toContactEventRecord(row: any): ContactEventRecord {
	return {
		id: row.id,
		contactId: row.contactId,
		providerIdentityId: row.providerIdentityId,
		provider: row.provider,
		providerEventId: row.providerEventId,
		providerReference: row.providerReference,
		eventType: row.eventType,
		occurredAt: toIso(row.occurredAt),
		createdAt: toIso(row.createdAt),
		semanticIdempotencyKey: row.semanticIdempotencyKey,
		privacyLevel: row.privacyLevel,
		identityEvidence: row.identityEvidence,
		payloadSummary: row.payloadSummary,
		schemaVersion: row.schemaVersion,
	}
}

function isDueRetryableIntent(intent: SideEffectIntent, now: string) {
	if (intent.status !== 'failed') return false
	if (intent.metadata.retryable !== true) return false
	const nextRetryAt =
		typeof intent.metadata.nextRetryAt === 'string'
			? intent.metadata.nextRetryAt
			: undefined
	return !nextRetryAt || nextRetryAt <= now
}

function toSideEffectIntentRecord(row: any): SideEffectIntent {
	return {
		id: row.id,
		nextActionId: row.nextActionId,
		contactId: row.contactId,
		provider: row.provider,
		type: row.type,
		status: row.status,
		completedAt: row.completedAt ? toIso(row.completedAt) : null,
		idempotencyKey: row.idempotencyKey,
		gates: row.gates,
		reviewReasons: row.reviewReasons,
		metadata: row.metadata,
		createdAt: toIso(row.createdAt),
	}
}

function toContactStateRecord(row: any): ContactState {
	return {
		id: row.id,
		contactId: row.contactId,
		lifecycle: row.lifecycle,
		primaryBucket: row.primaryBucket,
		allBuckets: row.allBuckets,
		whySignals: row.whySignals,
		whoSignals: row.whoSignals,
		confidence: Number(row.confidence),
		rationale: row.rationale,
		reviewSignals: row.reviewSignals,
		humanReview: Boolean(row.humanReview),
		optInAttribution: row.optInAttribution ?? null,
		lastEventId: row.lastEventId,
		schemaVersion: row.schemaVersion,
		updatedAt: toIso(row.updatedAt),
	}
}

const LEARNER_FLOW_METADATA_STRING_MAX_BYTES = 500

function jsonString(
	column: SQL | typeof sideEffectIntent.metadata,
	path: string,
) {
	return sql<string | null>`CASE
		WHEN JSON_TYPE(JSON_EXTRACT(${column}, ${path})) = 'STRING'
			AND OCTET_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(${column}, ${path}))) <= ${LEARNER_FLOW_METADATA_STRING_MAX_BYTES}
		THEN JSON_UNQUOTE(JSON_EXTRACT(${column}, ${path}))
		ELSE NULL
	END`
}

function jsonNumber(
	column: SQL | typeof sideEffectIntent.metadata,
	path: string,
) {
	return sql<number | null>`CASE
		WHEN JSON_TYPE(JSON_EXTRACT(${column}, ${path})) IN ('INTEGER', 'DOUBLE', 'DECIMAL')
		THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(${column}, ${path})) AS DOUBLE)
		ELSE NULL
	END`
}

function jsonBoolean(
	column: SQL | typeof sideEffectIntent.metadata,
	path: string,
) {
	return sql<number | null>`CASE
		WHEN JSON_TYPE(JSON_EXTRACT(${column}, ${path})) = 'BOOLEAN'
		THEN JSON_UNQUOTE(JSON_EXTRACT(${column}, ${path})) = 'true'
		ELSE NULL
	END`
}

function compactDefined(values: Record<string, unknown>) {
	return Object.fromEntries(
		Object.entries(values).filter(([, value]) => value !== undefined),
	)
}

function isSequenceExhaustionIntentStatus(
	status: SideEffectIntent['status'],
) {
	return (
		status === 'pending' ||
		status === 'completed' ||
		status === 'failed' ||
		status === 'blocked'
	)
}

function stringValue(value: unknown) {
	return typeof value === 'string' ? value : undefined
}

function toJsonString(value: unknown) {
	return typeof value === 'string' && value !== 'null' ? value : undefined
}

function toJsonNumber(value: unknown) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function toJsonBoolean(value: unknown) {
	if (value === true || value === 1) return true
	if (value === false || value === 0) return false
	return undefined
}

function toIso(value: string | Date) {
	return value instanceof Date
		? value.toISOString()
		: new Date(value).toISOString()
}
