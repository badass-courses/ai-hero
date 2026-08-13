import {
	contact,
	contactEvent,
	contactState,
	nextAction,
	providerIdentity,
	sideEffectIntent,
	stateTransition,
} from '@/db/schema'
import { and, asc, eq, gt, inArray, type SQL } from 'drizzle-orm'

import { guid } from '@coursebuilder/utils/guid'

import { createInternalId } from '../internal-id'
import { withMysqlPrimaryKeyRetry } from '../mysql-primary-key-retry'
import type {
	CaptureMarketingRepository,
	LinkedActionRecords,
} from './capture-contact-event'
import { excludeLearnerFlowCanary } from './learner-flow-canary-exclusion'
import {
	canonicalCompletionForWrite,
	isValuePathIntentCompleted,
} from './value-path-completion'
import {
	COURSE_VALUE_PATH_SLUGS,
	isCourseValuePathIntent,
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
// Summary reads keep the joined payload and related-row IN lists bounded.
export const LEARNER_FLOW_RECORD_PAGE_SIZE = 1000

export type LearnerFlowRecord = {
	contactId: string
	contact?: ContactRecord
	contactState?: ContactState
	intents: SideEffectIntent[]
	entryEvents: ContactEventRecord[]
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

	async updateContactOptInAttribution(contactId: string, attribution: NonNullable<ContactRecord['optInAttribution']>) {
		const current = await this.findContactById(contactId)
		if (!current) throw new Error(`Missing contact ${contactId}`)
		if (!current.optInAttribution) {
			await this.database.update(contact).set({ optInAttribution: attribution, updatedAt: new Date() }).where(eq(contact.id, contactId))
		}
		return { ...current, optInAttribution: current.optInAttribution ?? attribution }
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
		return (await this.findCompletedValuePathEmailSideEffectIntentScan(args)).intents
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
	 * Bounded learner-flow pages for aggregate callers. The ID query selects one
	 * varchar per learner. Each yielded page reuses the shared classifier.
	 */
	async *findSkillsWorkflowLearnerFlowRecordPages(options?: {
		includeCanary?: boolean
	}): AsyncGenerator<LearnerFlowRecord[]> {
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
							: excludeLearnerFlowCanary({ contactId: sideEffectIntent.contactId }),
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
			const learnerIds = intentContactIds.union(entryContactIds).as('learner_ids')
			const idRows = await this.database
				.select({ contactId: learnerIds.contactId })
				.from(learnerIds)
				.where(cursor === undefined ? undefined : gt(learnerIds.contactId, cursor))
				.orderBy(asc(learnerIds.contactId))
				.limit(LEARNER_FLOW_RECORD_PAGE_SIZE)
			const contactIds = idRows.map((row: { contactId: string }) => row.contactId)
			if (contactIds.length === 0) return
			yield await this.findSkillsWorkflowLearnerFlowRecordsByContactIds(contactIds)
			if (contactIds.length < LEARNER_FLOW_RECORD_PAGE_SIZE) return
			cursor = contactIds[contactIds.length - 1]
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
	): Promise<LearnerFlowRecord[]> {
		if (contactIds.length === 0) return []
		const [intentRows, entryEventRows, contacts, states]: [any[], any[], any[], any[]] =
			await Promise.all([
				this.selectValuePathIntentRowsPaged(
					inArray(sideEffectIntent.contactId, contactIds),
				),
				this.database
					.select()
					.from(contactEvent)
					.where(
						and(
							inArray(contactEvent.contactId, contactIds),
							eq(contactEvent.eventType, 'value-path.entered'),
							inArray(
								contactEvent.providerReference,
								COURSE_VALUE_PATH_SLUGS.map((path) => `value-path:${path}`),
							),
						),
					),
				this.database.select().from(contact).where(inArray(contact.id, contactIds)),
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

	async updateSideEffectIntent(
		id: string,
		patch: Pick<
			SideEffectIntent,
			'status' | 'gates' | 'reviewReasons' | 'metadata'
		> & Pick<SideEffectIntent, 'completedAt'>,
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

function assembleLearnerFlowRecords(args: {
	contactIds: string[]
	intentRows: any[]
	entryEventRows: any[]
	contacts: any[]
	states: any[]
}): LearnerFlowRecord[] {
	const intents = args.intentRows.map(toSideEffectIntentRecord).filter(isCourseValuePathIntent)
	const entryEvents = args.entryEventRows.map(toContactEventRecord)
	const contactsById = new Map<string, ContactRecord>(
		args.contacts.map((record) => [record.id, toContactRecord(record)]),
	)
	const statesByContactId = new Map<string, ContactState>(
		args.states.map((record) => [record.contactId, toContactStateRecord(record)]),
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
	return args.contactIds.map((contactId) => ({
		contactId,
		contact: contactsById.get(contactId),
		contactState: statesByContactId.get(contactId),
		intents: sortValuePathIntentsByCreatedAt(intentsByContactId.get(contactId) ?? []),
		entryEvents: entryEventsByContactId.get(contactId) ?? [],
	}))
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

function toIso(value: string | Date) {
	return value instanceof Date
		? value.toISOString()
		: new Date(value).toISOString()
}
