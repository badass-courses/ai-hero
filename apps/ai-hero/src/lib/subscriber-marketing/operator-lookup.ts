import { planDryRunIntents } from './intent-planner'
import { classifyContactEvent } from './signal-classifier'
import { reduceContactState } from './state-reducer'
import type {
	ContactEventRecord,
	ContactIdentityEvidence,
	ContactLinkRecord,
	ContactRecord,
	ContactState,
	DryRunInspection,
	NextAction,
	Provider,
	ProviderIdentityRecord,
	SideEffectIntent,
	StateTransition,
} from './types'

export type OperatorLookupInput =
	| { type: 'email'; email: string }
	| { type: 'provider-identity'; provider: Provider; externalId: string }
	| { type: 'contact-id'; contactId: string }
	| { type: 'user-id'; userId: string }

export type OperatorProviderIdentitySnapshot = ProviderIdentityRecord
export type OperatorContactLinkSnapshot = ContactLinkRecord

export type OperatorContactSnapshot = {
	contact: ContactRecord
	providerIdentities: OperatorProviderIdentitySnapshot[]
	contactLinks: OperatorContactLinkSnapshot[]
	currentState?: ContactState
	recentEvents: ContactEventRecord[]
	recentTransitions: StateTransition[]
	nextActions: NextAction[]
	sideEffectIntents: SideEffectIntent[]
	privacy: {
		rawPayloadIncluded: false
		payloadSummaryOnly: true
		restrictedEventCount: number
	}
}

export type OperatorLookupResult = {
	mode: 'operator-lookup'
	input: OperatorLookupInput
	contacts: OperatorContactSnapshot[]
	ambiguous: boolean
	privacy: {
		rawPayloadIncluded: false
		payloadSummaryOnly: true
	}
}

export type ReplayPreviewResult = {
	mode: 'replay-preview'
	contact: ContactRecord
	storedState?: ContactState
	preview: DryRunInspection
	diff: {
		lifecycleChanged: boolean
		primaryBucketChanged: boolean
		humanReviewChanged: boolean
		confidenceChanged: boolean
	}
	privacy: {
		rawPayloadIncluded: false
		payloadSummaryOnly: true
	}
}

export type OperatorLookupRepository = {
	findContactById(contactId: string): Promise<ContactRecord | undefined>
	findContactsByEmail(email: string): Promise<ContactRecord[]>
	findContactsByUserId(userId: string): Promise<ContactRecord[]>
	findProviderIdentity(
		provider: Provider,
		externalId: string,
	): Promise<ProviderIdentityRecord | undefined>
	findProviderIdentitiesByContactId(
		contactId: string,
	): Promise<ProviderIdentityRecord[]>
	findContactLinksByContactId(contactId: string): Promise<ContactLinkRecord[]>
	findContactLinksByUserId(userId: string): Promise<ContactLinkRecord[]>
	findContactEventsByContactId(
		contactId: string,
		limit: number,
	): Promise<ContactEventRecord[]>
	findContactEventById(eventId: string): Promise<ContactEventRecord | undefined>
	findCurrentContactState(contactId: string): Promise<ContactState | undefined>
	findStateTransitionsByContactId(
		contactId: string,
		limit: number,
	): Promise<StateTransition[]>
	findNextActionsByContactId(
		contactId: string,
		limit: number,
	): Promise<NextAction[]>
	findSideEffectIntentsByContactId(
		contactId: string,
		limit: number,
	): Promise<SideEffectIntent[]>
}

export class InMemoryOperatorLookupRepository implements OperatorLookupRepository {
	constructor(
		private readonly records: {
			contacts: Map<string, ContactRecord>
			providerIdentities: Map<string, ProviderIdentityRecord>
			contactLinks?: Map<string, ContactLinkRecord>
			contactEvents: Map<string, ContactEventRecord>
			states: Map<string, ContactState>
			transitions: Map<string, StateTransition>
			nextActions: Map<string, NextAction>
			sideEffectIntents: Map<string, SideEffectIntent>
		},
	) {}

	async findContactById(contactId: string) {
		return this.records.contacts.get(contactId)
	}
	async findContactsByEmail(email: string) {
		const normalized = normalizeEmail(email)
		return Array.from(this.records.contacts.values()).filter(
			(contact) => contact.email === normalized,
		)
	}
	async findContactsByUserId(userId: string) {
		return Array.from(this.records.contacts.values()).filter(
			(contact) => contact.userId === userId,
		)
	}
	async findProviderIdentity(provider: Provider, externalId: string) {
		return Array.from(this.records.providerIdentities.values()).find(
			(identity) =>
				identity.provider === provider && identity.externalId === externalId,
		)
	}
	async findProviderIdentitiesByContactId(contactId: string) {
		return Array.from(this.records.providerIdentities.values()).filter(
			(identity) => identity.contactId === contactId,
		)
	}
	async findContactLinksByContactId(contactId: string) {
		return Array.from(this.records.contactLinks?.values() ?? []).filter(
			(link) => link.contactId === contactId,
		)
	}
	async findContactLinksByUserId(userId: string) {
		return Array.from(this.records.contactLinks?.values() ?? []).filter(
			(link) => link.userId === userId,
		)
	}
	async findContactEventsByContactId(contactId: string, limit: number) {
		return Array.from(this.records.contactEvents.values())
			.filter((event) => event.contactId === contactId)
			.sort(sortNewestFirst)
			.slice(0, limit)
	}
	async findContactEventById(eventId: string) {
		return this.records.contactEvents.get(eventId)
	}
	async findCurrentContactState(contactId: string) {
		return this.records.states.get(contactId)
	}
	async findStateTransitionsByContactId(contactId: string, limit: number) {
		return Array.from(this.records.transitions.values())
			.filter((transition) => transition.contactId === contactId)
			.sort(sortNewestFirst)
			.slice(0, limit)
	}
	async findNextActionsByContactId(contactId: string, limit: number) {
		return Array.from(this.records.nextActions.values())
			.filter((action) => action.contactId === contactId)
			.sort(sortNewestFirst)
			.slice(0, limit)
	}
	async findSideEffectIntentsByContactId(contactId: string, limit: number) {
		return Array.from(this.records.sideEffectIntents.values())
			.filter((intent) => intent.contactId === contactId)
			.sort(sortNewestFirst)
			.slice(0, limit)
	}
}

export async function lookupSubscriberMarketingContact(args: {
	repository: OperatorLookupRepository
	input: OperatorLookupInput
	limit?: number
}): Promise<OperatorLookupResult> {
	const limit = args.limit ?? 10
	const contacts = await resolveLookupContacts(args.repository, args.input)
	const snapshots = await Promise.all(
		contacts.slice(0, limit).map((contact) =>
			buildContactSnapshot({
				repository: args.repository,
				contact,
				limit,
			}),
		),
	)

	return {
		mode: 'operator-lookup',
		input: normalizeLookupInput(args.input),
		contacts: snapshots,
		ambiguous: contacts.length > 1,
		privacy: { rawPayloadIncluded: false, payloadSummaryOnly: true },
	}
}

export async function previewSubscriberMarketingReplay(args: {
	repository: OperatorLookupRepository
	contactId: string
	eventId?: string
	now?: string
}): Promise<ReplayPreviewResult> {
	const now = args.now ?? new Date().toISOString()
	const contact = await args.repository.findContactById(args.contactId)
	if (!contact) throw new Error(`Contact ${args.contactId} was not found`)

	const event = args.eventId
		? await args.repository.findContactEventById(args.eventId)
		: (await args.repository.findContactEventsByContactId(args.contactId, 1))[0]
	if (!event || event.contactId !== contact.id) {
		throw new Error(`No replayable event found for contact ${args.contactId}`)
	}

	const providerIdentity = (
		await args.repository.findProviderIdentitiesByContactId(contact.id)
	).find((identity) => identity.id === event.providerIdentityId)
	if (!providerIdentity) {
		throw new Error(
			`Provider identity ${event.providerIdentityId} was not found for contact ${contact.id}`,
		)
	}

	const storedState = await args.repository.findCurrentContactState(contact.id)
	const classification = classifyContactEvent(event)
	const previewState = reduceContactState({
		existingState: storedState,
		event,
		classification,
		now,
		id: storedState?.id ?? `preview_state_${event.id}`,
	})
	const planned = planDryRunIntents({
		state: previewState,
		event,
		now,
		nextActionId: `preview_next_action_${event.id}`,
		intentId: `preview_intent_${event.id}`,
	})
	const preview: DryRunInspection = {
		mode: 'dry-run',
		idempotentNoop: true,
		contact,
		providerIdentity: sanitizeProviderIdentity(providerIdentity),
		contactEvent: event,
		classification,
		contactState: previewState,
		nextAction: planned.nextAction,
		sideEffectIntents: planned.sideEffectIntents,
		privacy: { rawPayloadIncluded: false, payloadSummaryOnly: true },
	}

	return {
		mode: 'replay-preview',
		contact,
		storedState,
		preview,
		diff: {
			lifecycleChanged: storedState?.lifecycle !== previewState.lifecycle,
			primaryBucketChanged:
				storedState?.primaryBucket !== previewState.primaryBucket,
			humanReviewChanged: storedState?.humanReview !== previewState.humanReview,
			confidenceChanged: storedState?.confidence !== previewState.confidence,
		},
		privacy: { rawPayloadIncluded: false, payloadSummaryOnly: true },
	}
}

async function resolveLookupContacts(
	repository: OperatorLookupRepository,
	input: OperatorLookupInput,
) {
	if (input.type === 'email') {
		return repository.findContactsByEmail(input.email)
	}
	if (input.type === 'contact-id') {
		const contact = await repository.findContactById(input.contactId)
		return contact ? [contact] : []
	}
	if (input.type === 'provider-identity') {
		const identity = await repository.findProviderIdentity(
			input.provider,
			input.externalId,
		)
		const contact = identity
			? await repository.findContactById(identity.contactId)
			: undefined
		return contact ? [contact] : []
	}

	const directContacts = await repository.findContactsByUserId(input.userId)
	const links = await repository.findContactLinksByUserId(input.userId)
	const linkedContacts = await Promise.all(
		links.map((link) => repository.findContactById(link.contactId)),
	)
	return uniqueContacts([
		...directContacts,
		...linkedContacts.filter((contact): contact is ContactRecord =>
			Boolean(contact),
		),
	])
}

async function buildContactSnapshot(args: {
	repository: OperatorLookupRepository
	contact: ContactRecord
	limit: number
}): Promise<OperatorContactSnapshot> {
	const [
		providerIdentities,
		contactLinks,
		currentState,
		recentEvents,
		recentTransitions,
		nextActions,
		sideEffectIntents,
	] = await Promise.all([
		args.repository.findProviderIdentitiesByContactId(args.contact.id),
		args.repository.findContactLinksByContactId(args.contact.id),
		args.repository.findCurrentContactState(args.contact.id),
		args.repository.findContactEventsByContactId(args.contact.id, args.limit),
		args.repository.findStateTransitionsByContactId(
			args.contact.id,
			args.limit,
		),
		args.repository.findNextActionsByContactId(args.contact.id, args.limit),
		args.repository.findSideEffectIntentsByContactId(
			args.contact.id,
			args.limit,
		),
	])

	return {
		contact: args.contact,
		providerIdentities: providerIdentities.map(sanitizeProviderIdentity),
		contactLinks: contactLinks.map(sanitizeContactLink),
		currentState,
		recentEvents,
		recentTransitions,
		nextActions,
		sideEffectIntents,
		privacy: {
			rawPayloadIncluded: false,
			payloadSummaryOnly: true,
			restrictedEventCount: recentEvents.filter(
				(event) => event.privacyLevel === 'restricted',
			).length,
		},
	}
}

function normalizeLookupInput(input: OperatorLookupInput): OperatorLookupInput {
	if (input.type === 'email')
		return { ...input, email: normalizeEmail(input.email) }
	return input
}

function normalizeEmail(email: string) {
	return email.trim().toLowerCase()
}

function uniqueContacts(contacts: ContactRecord[]) {
	const seen = new Set<string>()
	return contacts.filter((contact) => {
		if (seen.has(contact.id)) return false
		seen.add(contact.id)
		return true
	})
}

function sanitizeProviderIdentity(
	identity: ProviderIdentityRecord,
): OperatorProviderIdentitySnapshot {
	return {
		...identity,
		evidence: sanitizeIdentityEvidence(identity.evidence),
	}
}

function sanitizeContactLink(
	link: ContactLinkRecord,
): OperatorContactLinkSnapshot {
	return {
		...link,
		evidence: sanitizeIdentityEvidence(link.evidence),
	}
}

function sanitizeIdentityEvidence(
	evidence: ContactLinkRecord['evidence'],
): ContactIdentityEvidence {
	const source = isProvider(evidence.source) ? evidence.source : 'fixture'
	const strength = isEvidenceStrength(evidence.strength)
		? evidence.strength
		: 'weak'
	const providerIdentity = isProviderIdentityEvidence(evidence.providerIdentity)
		? evidence.providerIdentity
		: undefined

	return {
		email: typeof evidence.email === 'string' ? evidence.email : undefined,
		name: typeof evidence.name === 'string' ? evidence.name : undefined,
		userId: typeof evidence.userId === 'string' ? evidence.userId : undefined,
		providerIdentity,
		source,
		strength,
	}
}

function isProvider(value: unknown): value is Provider {
	return (
		value === 'fixture' ||
		value === 'front' ||
		value === 'kit' ||
		value === 'ai-hero'
	)
}

function isEvidenceStrength(
	value: unknown,
): value is ContactIdentityEvidence['strength'] {
	return value === 'weak' || value === 'medium' || value === 'strong'
}

function isProviderIdentityEvidence(
	value: unknown,
): value is NonNullable<ContactIdentityEvidence['providerIdentity']> {
	if (!value || typeof value !== 'object') return false
	const candidate = value as Record<string, unknown>
	return (
		isProvider(candidate.provider) && typeof candidate.externalId === 'string'
	)
}

function sortNewestFirst<T extends { createdAt: string; occurredAt?: string }>(
	a: T,
	b: T,
) {
	const bKey = `${b.occurredAt ?? b.createdAt}:${b.createdAt}`
	const aKey = `${a.occurredAt ?? a.createdAt}:${a.createdAt}`
	return bKey.localeCompare(aKey)
}
