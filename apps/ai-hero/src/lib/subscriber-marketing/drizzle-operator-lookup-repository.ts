import {
	contact,
	contactEvent,
	contactLink,
	contactState,
	nextAction,
	providerIdentity,
	sideEffectIntent,
	stateTransition,
	users,
} from '@/db/schema'
import { and, desc, eq } from 'drizzle-orm'

import type { OperatorLookupRepository } from './operator-lookup'
import type {
	ClassificationResult,
	ContactEventRecord,
	ContactIdentityEvidence,
	ContactLifecycle,
	ContactLinkRecord,
	ContactRecord,
	ContactState,
	Gate,
	NextAction,
	NextActionStatus,
	PayloadSummary,
	PrivacyLevel,
	Provider,
	ProviderIdentityRecord,
	SideEffectIntent,
	SideEffectIntentStatus,
	StateTransition,
} from './types'

type AiHeroDatabase = {
	select: (selection?: any) => any
}

export class DrizzleOperatorLookupRepository implements OperatorLookupRepository {
	constructor(private readonly database: AiHeroDatabase) {}

	async findContactById(contactId: string) {
		const rows = await this.database
			.select({ contact, userEmail: users.email })
			.from(contact)
			.leftJoin(users, eq(contact.userId, users.id))
			.where(eq(contact.id, contactId))
			.limit(1)
		return rows[0]
			? toContactRecordWithUserEmail(rows[0].contact, rows[0].userEmail)
			: undefined
	}

	async findContactsByEmail(email: string) {
		const rows = await this.database
			.select()
			.from(contact)
			.where(eq(contact.email, email.trim().toLowerCase()))
		return rows.map(toContactRecord)
	}

	async findContactsByUserId(userId: string) {
		const rows = await this.database
			.select()
			.from(contact)
			.where(eq(contact.userId, userId))
		return rows.map(toContactRecord)
	}

	async findProviderIdentity(provider: Provider, externalId: string) {
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

	async findProviderIdentitiesByContactId(contactId: string) {
		const rows = await this.database
			.select()
			.from(providerIdentity)
			.where(eq(providerIdentity.contactId, contactId))
		return rows.map(toProviderIdentityRecord)
	}

	async findContactLinksByContactId(contactId: string) {
		const rows = await this.database
			.select()
			.from(contactLink)
			.where(eq(contactLink.contactId, contactId))
		return rows.map(toContactLinkRecord)
	}

	async findContactLinksByUserId(userId: string) {
		const rows = await this.database
			.select()
			.from(contactLink)
			.where(eq(contactLink.userId, userId))
		return rows.map(toContactLinkRecord)
	}

	async findContactEventsByContactId(contactId: string, limit: number) {
		const rows = await this.database
			.select()
			.from(contactEvent)
			.where(eq(contactEvent.contactId, contactId))
			.orderBy(desc(contactEvent.occurredAt), desc(contactEvent.createdAt))
			.limit(limit)
		return rows.map(toContactEventRecord)
	}

	async findContactEventById(eventId: string) {
		const rows = await this.database
			.select()
			.from(contactEvent)
			.where(eq(contactEvent.id, eventId))
			.limit(1)
		return rows[0] ? toContactEventRecord(rows[0]) : undefined
	}

	async findCurrentContactState(contactId: string) {
		const rows = await this.database
			.select()
			.from(contactState)
			.where(eq(contactState.contactId, contactId))
			.limit(1)
		return rows[0] ? toContactStateRecord(rows[0]) : undefined
	}

	async findStateTransitionsByContactId(contactId: string, limit: number) {
		const rows = await this.database
			.select()
			.from(stateTransition)
			.where(eq(stateTransition.contactId, contactId))
			.orderBy(desc(stateTransition.createdAt))
			.limit(limit)
		return rows.map(toStateTransitionRecord)
	}

	async findNextActionsByContactId(contactId: string, limit: number) {
		const rows = await this.database
			.select()
			.from(nextAction)
			.where(eq(nextAction.contactId, contactId))
			.orderBy(desc(nextAction.createdAt))
			.limit(limit)
		return rows.map(toNextActionRecord)
	}

	async findSideEffectIntentsByContactId(contactId: string, limit: number) {
		const rows = await this.database
			.select()
			.from(sideEffectIntent)
			.where(eq(sideEffectIntent.contactId, contactId))
			.orderBy(desc(sideEffectIntent.createdAt))
			.limit(limit)
		return rows.map(toSideEffectIntentRecord)
	}
}

function toContactRecordWithUserEmail(
	row: any,
	userEmail?: string | null,
): ContactRecord {
	return toContactRecord({
		...row,
		email: row.email ?? userEmail ?? null,
	})
}

function toContactRecord(row: any): ContactRecord {
	return {
		id: row.id,
		userId: row.userId,
		email: row.email,
		name: row.name,
		lifecycle: row.lifecycle as ContactLifecycle,
		isProvisional: Boolean(row.isProvisional),
		createdAt: toIso(row.createdAt),
		updatedAt: toIso(row.updatedAt),
	}
}

function toProviderIdentityRecord(row: any): ProviderIdentityRecord {
	return {
		id: row.id,
		contactId: row.contactId,
		provider: row.provider as Provider,
		externalId: row.externalId,
		evidence: row.evidence as ContactIdentityEvidence,
		createdAt: toIso(row.createdAt),
		updatedAt: toIso(row.updatedAt),
	}
}

function toContactLinkRecord(row: any): ContactLinkRecord {
	return {
		id: row.id,
		contactId: row.contactId,
		userId: row.userId,
		reason: row.reason,
		evidence: row.evidence as ContactIdentityEvidence,
		createdAt: toIso(row.createdAt),
	}
}

function toContactEventRecord(row: any): ContactEventRecord {
	return {
		id: row.id,
		contactId: row.contactId,
		providerIdentityId: row.providerIdentityId,
		provider: row.provider as Provider,
		providerEventId: row.providerEventId,
		providerReference: row.providerReference,
		eventType: row.eventType,
		occurredAt: toIso(row.occurredAt),
		createdAt: toIso(row.createdAt),
		semanticIdempotencyKey: row.semanticIdempotencyKey,
		privacyLevel: row.privacyLevel as PrivacyLevel,
		identityEvidence: row.identityEvidence as ContactIdentityEvidence,
		payloadSummary: row.payloadSummary as PayloadSummary,
		schemaVersion: row.schemaVersion,
	}
}

function toContactStateRecord(row: any): ContactState {
	return {
		id: row.id,
		contactId: row.contactId,
		lifecycle: row.lifecycle as ContactLifecycle,
		primaryBucket: row.primaryBucket,
		allBuckets: row.allBuckets,
		whySignals: row.whySignals,
		whoSignals: row.whoSignals,
		confidence: Number(row.confidence),
		rationale: row.rationale,
		reviewSignals: row.reviewSignals,
		humanReview: Boolean(row.humanReview),
		lastEventId: row.lastEventId,
		schemaVersion: row.schemaVersion,
		updatedAt: toIso(row.updatedAt),
	}
}

function toStateTransitionRecord(row: any): StateTransition {
	return {
		id: row.id,
		contactId: row.contactId,
		fromStateId: row.fromStateId ?? undefined,
		toStateId: row.toStateId,
		eventId: row.eventId,
		signals: row.signals as ClassificationResult,
		rationale: row.rationale,
		createdAt: toIso(row.createdAt),
	}
}

function toNextActionRecord(row: any): NextAction {
	return {
		id: row.id,
		contactId: row.contactId,
		contactStateId: row.contactStateId,
		eventId: row.eventId,
		type: row.type,
		status: row.status as NextActionStatus,
		gates: row.gates as Gate[],
		reviewReasons: row.reviewReasons,
		rationale: row.rationale,
		createdAt: toIso(row.createdAt),
	}
}

function toSideEffectIntentRecord(row: any): SideEffectIntent {
	return {
		id: row.id,
		nextActionId: row.nextActionId,
		contactId: row.contactId,
		provider: 'dry-run',
		type: row.type,
		status: row.status as SideEffectIntentStatus,
		completedAt: row.completedAt ? toIso(row.completedAt) : null,
		idempotencyKey: row.idempotencyKey,
		gates: row.gates as Gate[],
		reviewReasons: row.reviewReasons,
		metadata: row.metadata,
		createdAt: toIso(row.createdAt),
	}
}

function toIso(value: string | Date) {
	return value instanceof Date
		? value.toISOString()
		: new Date(value).toISOString()
}
