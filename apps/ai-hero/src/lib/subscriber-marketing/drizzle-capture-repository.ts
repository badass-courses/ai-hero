import {
	contact,
	contactEvent,
	contactState,
	nextAction,
	providerIdentity,
	sideEffectIntent,
	stateTransition,
} from '@/db/schema'
import { and, eq, inArray } from 'drizzle-orm'

import { guid } from '@coursebuilder/utils/guid'

import type { CaptureMarketingRepository } from './capture-contact-event'
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

export type LearnerFlowRecord = {
	contactId: string
	contact?: ContactRecord
	contactState?: ContactState
	intents: SideEffectIntent[]
	entryEvents: ContactEventRecord[]
}

export class DrizzleCaptureMarketingRepository implements CaptureMarketingRepository {
	constructor(private readonly database: AiHeroWriteDatabase) {}

	newId(_kind: string) {
		return guid()
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
		await this.database.insert(contactEvent).values({
			...record,
			occurredAt: new Date(record.occurredAt),
			createdAt: new Date(record.createdAt),
		})
		return record
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
		await this.database.insert(nextAction).values({
			...input,
			createdAt: new Date(input.createdAt),
		})
		return input
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
		const completedAt = canonicalCompletionForWrite(input)
		const record = { ...input, completedAt }
		await this.database.insert(sideEffectIntent).values({
			...record,
			completedAt: completedAt ? new Date(completedAt) : null,
			createdAt: new Date(input.createdAt),
		})
		return record
	}

	async findPendingValuePathEmailSideEffectIntents(args: {
		limit: number
		intentIds?: string[]
	}) {
		const rows = await this.database
			.select()
			.from(sideEffectIntent)
			.where(
				and(
					eq(sideEffectIntent.provider, 'kit'),
					eq(sideEffectIntent.type, 'send-value-path-email'),
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
		const rows = await this.database
			.select()
			.from(sideEffectIntent)
			.where(
				and(
					eq(sideEffectIntent.provider, 'kit'),
					eq(sideEffectIntent.type, 'send-value-path-email'),
				),
			)
		return rows.map(toSideEffectIntentRecord)
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

	/** Read-only course-path scan for the daily learner-flow operator. */
	async findSkillsWorkflowLearnerFlowRecords(options?: {
		includeCanary?: boolean
	}): Promise<LearnerFlowRecord[]> {
		const [intentRows, entryEventRows]: [any[], any[]] = await Promise.all([
			this.database
				.select()
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
		const intents: SideEffectIntent[] = intentRows
			.map(toSideEffectIntentRecord)
			.filter(isCourseValuePathIntent)
		const entryEvents: ContactEventRecord[] = entryEventRows.map(
			toContactEventRecord,
		)
		const contactIds: string[] = Array.from(
			new Set([
				...intents.map((intent) => intent.contactId),
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
		const contactsById = new Map<string, ContactRecord>(
			contacts.map((record) => [record.id, toContactRecord(record)]),
		)
		const statesByContactId = new Map<string, ContactState>(
			states.map((record) => [
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
		return contactIds.map((contactId) => ({
			contactId,
			contact: contactsById.get(contactId),
			contactState: statesByContactId.get(contactId),
			intents: sortValuePathIntentsByCreatedAt(
				intentsByContactId.get(contactId) ?? [],
			),
			entryEvents: entryEventsByContactId.get(contactId) ?? [],
		}))
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
