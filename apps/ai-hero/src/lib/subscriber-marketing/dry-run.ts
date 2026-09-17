import {
	COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
	courseSequenceExhaustionFactKey,
	restoreCourseSequenceExhaustedPayload,
	restoreEmailCourseEntryPayload,
	type CourseSequenceExhaustionCommitRequest,
	type CourseSequenceExhaustionCommitResult,
	type EmailCourseEntryEventRecord,
} from './course-sequence-exhaustion'
import {
	resolveOrCreateIdentity,
	type IdentityRepository,
} from './identity-resolution'
import { planDryRunIntents } from './intent-planner'
import { normalizeContactEvent } from './normalize-contact-event'
import { classifyContactEvent } from './signal-classifier'
import { reduceContactState } from './state-reducer'
import type {
	ContactEventRecord,
	ContactLinkRecord,
	ContactRecord,
	ContactState,
	DryRunInspection,
	FixtureContactEventInput,
	NextAction,
	ProviderIdentityRecord,
	SideEffectIntent,
	StateTransition,
} from './types'
import {
	canonicalCompletionForWrite,
	isValuePathIntentCompleted,
} from './value-path-completion'
import {
	scanCompletedValuePathIntentFrontier,
	selectCompletedValuePathIntentFrontier,
	sortValuePathIntentsByCreatedAt,
	type CompletedValuePathIntentScanArgs,
} from './value-path-intent-scan'

export type MarketingRepository = IdentityRepository & {
	findContactEventBySemanticKey(key: string): ContactEventRecord | undefined
	createContactEvent(
		input: Omit<ContactEventRecord, 'id' | 'createdAt'> & {
			createdAt?: string
		},
	): ContactEventRecord
	createEmailCourseEntryEvent(
		input: Omit<EmailCourseEntryEventRecord, 'id' | 'createdAt'> & {
			createdAt?: string
		},
	): EmailCourseEntryEventRecord
	findCurrentContactState(contactId: string): ContactState | undefined
	upsertContactState(state: ContactState): ContactState
	createStateTransition(input: Omit<StateTransition, 'id'>): StateTransition
	createNextAction(input: NextAction): NextAction
	findSideEffectIntentByIdempotencyKey(
		idempotencyKey: string,
	): SideEffectIntent | undefined
	createSideEffectIntent(input: SideEffectIntent): SideEffectIntent
	commitCourseSequenceExhaustion(
		request: CourseSequenceExhaustionCommitRequest,
	): CourseSequenceExhaustionCommitResult
	findPendingValuePathEmailSideEffectIntents(args: {
		limit: number
	}): SideEffectIntent[]
	findCompletedValuePathEmailSideEffectIntents(args: {
		limit: number
		maxCompletedAt?: string
	}): SideEffectIntent[]
	findValuePathEmailSideEffectIntentsByContact(
		contactId: string,
	): SideEffectIntent[]
	updateSideEffectIntent(
		id: string,
		patch: Pick<
			SideEffectIntent,
			'status' | 'gates' | 'reviewReasons' | 'metadata'
		> &
			Pick<SideEffectIntent, 'completedAt'>,
	): SideEffectIntent
}

const createIdFactory = (prefix = 'sm') => {
	let next = 0
	return (kind: string) => `${prefix}_${kind}_${++next}`
}

export class InMemorySubscriberMarketingRepository implements MarketingRepository {
	contacts = new Map<string, ContactRecord>()
	providerIdentities = new Map<string, ProviderIdentityRecord>()
	contactLinks = new Map<string, ContactLinkRecord>()
	contactEvents = new Map<string, ContactEventRecord>()
	states = new Map<string, ContactState>()
	transitions = new Map<string, StateTransition>()
	nextActions = new Map<string, NextAction>()
	sideEffectIntents = new Map<string, SideEffectIntent>()
	private id = createIdFactory('fixture')

	findContactById(id: string) {
		return this.contacts.get(id)
	}
	findContactByEmail(email: string) {
		return Array.from(this.contacts.values()).find(
			(contact) => contact.email === email,
		)
	}
	findContactByUserId(userId: string) {
		return Array.from(this.contacts.values()).find(
			(contact) => contact.userId === userId,
		)
	}
	findProviderIdentity(provider: string, externalId: string) {
		return Array.from(this.providerIdentities.values()).find(
			(identity) =>
				identity.provider === provider && identity.externalId === externalId,
		)
	}
	createContact(input: Omit<ContactRecord, 'id'>) {
		const contact = { id: this.id('contact'), ...input }
		this.contacts.set(contact.id, contact)
		return contact
	}

	updateContactOptInAttribution(
		contactId: string,
		attribution: NonNullable<ContactRecord['optInAttribution']>,
	) {
		const current = this.contacts.get(contactId)
		if (!current) throw new Error(`Missing contact ${contactId}`)
		const updated = {
			...current,
			optInAttribution: current.optInAttribution ?? attribution,
		}
		this.contacts.set(contactId, updated)
		return updated
	}
	createProviderIdentity(input: Omit<ProviderIdentityRecord, 'id'>) {
		const identity = { id: this.id('provider_identity'), ...input }
		this.providerIdentities.set(identity.id, identity)
		return identity
	}
	linkProviderIdentityToContact(identityId: string, contactId: string) {
		const identity = this.providerIdentities.get(identityId)
		if (!identity) throw new Error(`Missing provider identity ${identityId}`)
		const updated = { ...identity, contactId }
		this.providerIdentities.set(identityId, updated)
		return updated
	}
	createContactLink(input: Omit<ContactLinkRecord, 'id'>) {
		const link = { id: this.id('contact_link'), ...input }
		this.contactLinks.set(link.id, link)
		return link
	}
	findContactEventBySemanticKey(key: string) {
		return Array.from(this.contactEvents.values()).find(
			(event) => event.semanticIdempotencyKey === key,
		)
	}
	findContactEventsByType(contactId: string, eventType: string) {
		return Array.from(this.contactEvents.values()).filter(
			(event) => event.contactId === contactId && event.eventType === eventType,
		)
	}
	createContactEvent(
		input: Omit<ContactEventRecord, 'id' | 'createdAt'> & {
			createdAt?: string
		},
	) {
		const event = {
			id: this.id('event'),
			createdAt: input.createdAt ?? new Date().toISOString(),
			...input,
		}
		this.contactEvents.set(event.id, event)
		return event
	}
	createEmailCourseEntryEvent(
		input: Omit<EmailCourseEntryEventRecord, 'id' | 'createdAt'> & {
			createdAt?: string
		},
	) {
		const event: EmailCourseEntryEventRecord = {
			id: this.id('event'),
			createdAt: input.createdAt ?? new Date().toISOString(),
			...input,
		}
		this.contactEvents.set(event.id, event)
		return event
	}
	findCurrentContactState(contactId: string) {
		return this.states.get(contactId)
	}
	upsertContactState(state: ContactState) {
		this.states.set(state.contactId, state)
		return state
	}
	createStateTransition(input: Omit<StateTransition, 'id'>) {
		const transition = { id: this.id('transition'), ...input }
		this.transitions.set(transition.id, transition)
		return transition
	}
	createNextAction(input: NextAction) {
		this.nextActions.set(input.id, input)
		return input
	}
	commitCourseSequenceExhaustion(
		request: CourseSequenceExhaustionCommitRequest,
	): CourseSequenceExhaustionCommitResult {
		const payload = restoreCourseSequenceExhaustedPayload(
			request.records.fact.domainPayload,
		)
		const source = this.sideEffectIntents.get(request.sourceIntentId)
		const entry = this.contactEvents.get(request.courseEntryEventId)
		const entryPayload = restoreEmailCourseEntryPayload(entry?.domainPayload)
		if (
			!payload ||
			!source ||
			!entry ||
			source.id !== request.sourceIntentId ||
			source.id !== payload.progression.from.intentId ||
			source.status !== 'completed' ||
			!source.completedAt ||
			source.completedAt !== payload.progression.from.completedAt ||
			source.idempotencyKey !== payload.progression.from.idempotencyKey ||
			source.metadata.valuePathSlug !== payload.actor.valuePathId ||
			source.metadata.emailResourceId !==
				payload.progression.from.emailResourceId ||
			source.contactId !== payload.actor.contactId ||
			source.contactId !== request.records.fact.contactId ||
			entry.id !== request.courseEntryEventId ||
			entry.id !== payload.actor.courseEntryEventId ||
			entry.contactId !== request.records.fact.contactId ||
			entry.eventType !== 'value-path.entered' ||
			request.records.fact.provider !== 'ai-hero' ||
			request.records.fact.contactId !== payload.actor.contactId ||
			request.records.fact.occurredAt !== payload.exhaustedAt ||
			request.records.fact.domainFactKey !==
				courseSequenceExhaustionFactKey({
					contactId: payload.actor.contactId,
					valuePathId: payload.actor.valuePathId,
				}) ||
			request.records.fact.semanticIdempotencyKey !==
				request.records.fact.domainFactKey ||
			request.records.nextAction.id !==
				payload.progression.terminal.nextActionId ||
			request.records.nextAction.eventId !== request.records.fact.id ||
			request.records.nextAction.contactId !== payload.actor.contactId ||
			request.records.terminalIntent.id !==
				payload.progression.terminal.intentId ||
			request.records.terminalIntent.nextActionId !==
				request.records.nextAction.id ||
			request.records.terminalIntent.contactId !== payload.actor.contactId ||
			request.records.terminalIntent.provider !== 'kit' ||
			request.records.terminalIntent.type !== 'send-value-path-email' ||
			request.records.terminalIntent.status !== 'pending' ||
			(entryPayload
				? JSON.stringify(entryPayload.deadlineTimeZone) !==
					JSON.stringify(payload.deadlineTimeZone)
				: payload.deadlineTimeZone.type !== 'ExplicitFallback' ||
					payload.deadlineTimeZone.reason !== 'legacy-entry')
		) {
			throw new Error('Sequence exhaustion source evidence is invalid')
		}
		const existingFact = Array.from(this.contactEvents.values()).find(
			(event) => event.domainFactKey === request.records.fact.domainFactKey,
		)
		const existingIntent = this.findSideEffectIntentByIdempotencyKey(
			request.records.terminalIntent.idempotencyKey,
		)
		if (!existingFact && existingIntent) {
			return {
				status: 'legacy-terminal-intent-without-fact',
				terminalIntentId: existingIntent.id,
			}
		}
		if (existingFact && !existingIntent) {
			throw new Error('Sequence exhaustion fact exists without terminal intent')
		}
		if (existingFact && existingIntent) {
			const action = this.nextActions.get(existingIntent.nextActionId)
			const storedPayload = restoreCourseSequenceExhaustedPayload(
				existingFact.domainPayload,
			)
			if (
				!action ||
				!storedPayload ||
				existingFact.provider !== 'ai-hero' ||
				existingFact.eventType !== 'course.sequence-exhausted' ||
				existingFact.payloadFormat !==
					COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT ||
				!existingFact.domainFactKey ||
				action.id !== storedPayload.progression.terminal.nextActionId ||
				action.eventId !== existingFact.id ||
				action.contactId !== storedPayload.actor.contactId ||
				action.type !== 'advance-value-path' ||
				action.status !== 'planned' ||
				existingIntent.id !== storedPayload.progression.terminal.intentId ||
				existingIntent.nextActionId !== action.id ||
				existingIntent.contactId !== storedPayload.actor.contactId ||
				existingIntent.provider !== 'kit' ||
				existingIntent.type !== 'send-value-path-email' ||
				!isSequenceExhaustionIntentStatus(existingIntent.status) ||
				existingIntent.metadata.sequenceExhaustionFactId !== existingFact.id
			) {
				throw new Error('Stored sequence exhaustion pair is mismatched')
			}
			return {
				status: 'replayed',
				records: {
					fact: {
						...existingFact,
						provider: 'ai-hero',
						eventType: 'course.sequence-exhausted',
						domainFactKey: existingFact.domainFactKey,
						payloadFormat: COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
						domainPayload: storedPayload,
					},
					nextAction: {
						...action,
						type: 'advance-value-path',
						status: 'planned',
					},
					terminalIntent: {
						...existingIntent,
						provider: 'kit',
						type: 'send-value-path-email',
					},
				},
			}
		}
		const fact = request.records.fact
		const action = request.records.nextAction
		const terminalIntent = request.records.terminalIntent
		this.contactEvents.set(fact.id, fact)
		this.nextActions.set(action.id, action)
		this.sideEffectIntents.set(terminalIntent.id, terminalIntent)
		return {
			status: 'committed',
			records: request.records,
		}
	}
	findSideEffectIntentByIdempotencyKey(idempotencyKey: string) {
		return Array.from(this.sideEffectIntents.values()).find(
			(intent) => intent.idempotencyKey === idempotencyKey,
		)
	}
	createSideEffectIntent(input: SideEffectIntent) {
		const record = {
			...input,
			completedAt: canonicalCompletionForWrite(input),
		}
		this.sideEffectIntents.set(record.id, record)
		return record
	}
	findPendingValuePathEmailSideEffectIntents(args: { limit: number }) {
		const now = new Date().toISOString()
		const due = Array.from(this.sideEffectIntents.values()).filter(
			(intent) =>
				intent.provider === 'kit' &&
				intent.type === 'send-value-path-email' &&
				!isValuePathIntentCompleted(intent) &&
				(intent.status === 'pending' || isDueRetryableIntent(intent, now)),
		)
		return sortValuePathIntentsByCreatedAt(due).slice(0, args.limit)
	}
	findCompletedValuePathEmailSideEffectIntentScan(
		args: Omit<CompletedValuePathIntentScanArgs, 'intents'>,
	) {
		return scanCompletedValuePathIntentFrontier({
			...args,
			intents: this.findValuePathEmailSideEffectIntentsForScan(),
		})
	}
	findCompletedValuePathEmailSideEffectIntents(
		args: Omit<CompletedValuePathIntentScanArgs, 'intents'>,
	) {
		return selectCompletedValuePathIntentFrontier({
			...args,
			intents: this.findValuePathEmailSideEffectIntentsForScan(),
		})
	}
	findValuePathEmailSideEffectIntentsForScan() {
		return Array.from(this.sideEffectIntents.values()).filter(
			(intent) =>
				intent.provider === 'kit' && intent.type === 'send-value-path-email',
		)
	}
	findCompletedValuePathEmailSideEffectIntentsForRepair() {
		return this.findValuePathEmailSideEffectIntentsForScan().filter(
			(intent) =>
				intent.status === 'completed' || isValuePathIntentCompleted(intent),
		)
	}
	findValuePathEmailSideEffectIntentsByContact(contactId: string) {
		const intents = Array.from(this.sideEffectIntents.values()).filter(
			(intent) =>
				intent.contactId === contactId &&
				intent.provider === 'kit' &&
				intent.type === 'send-value-path-email',
		)
		return sortValuePathIntentsByCreatedAt(intents)
	}
	updateSideEffectIntent(
		id: string,
		patch: Pick<
			SideEffectIntent,
			'status' | 'gates' | 'reviewReasons' | 'metadata'
		> &
			Pick<SideEffectIntent, 'completedAt'>,
	) {
		const existing = this.sideEffectIntents.get(id)
		if (!existing) throw new Error(`Missing side effect intent ${id}`)
		const updated = {
			...existing,
			...patch,
			completedAt: canonicalCompletionForWrite(patch),
		}
		this.sideEffectIntents.set(id, updated)
		return updated
	}
	newId(kind: string) {
		return this.id(kind)
	}
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

function isDueRetryableIntent(intent: SideEffectIntent, now: string) {
	if (intent.status !== 'failed') return false
	if (intent.metadata.retryable !== true) return false
	const nextRetryAt =
		typeof intent.metadata.nextRetryAt === 'string'
			? intent.metadata.nextRetryAt
			: undefined
	return !nextRetryAt || nextRetryAt <= now
}

export async function dryRunSubscriberMarketingFixture(args: {
	fixture: FixtureContactEventInput
	repository?: InMemorySubscriberMarketingRepository
	now?: string
}): Promise<DryRunInspection> {
	const repository =
		args.repository ?? new InMemorySubscriberMarketingRepository()
	const now = args.now ?? new Date().toISOString()
	const normalized = normalizeContactEvent(args.fixture)
	const existingEvent = repository.findContactEventBySemanticKey(
		normalized.semanticIdempotencyKey,
	)
	const identity = resolveOrCreateIdentity({
		repository,
		event: normalized,
		now,
	})

	if (existingEvent) {
		const existingState = repository.findCurrentContactState(
			identity.contact.id,
		)
		const classification = classifyContactEvent(normalized)
		const state =
			existingState ??
			reduceContactState({
				event: existingEvent,
				classification,
				now,
				id: repository.newId('state'),
			})
		const planned = planDryRunIntents({
			state,
			event: existingEvent,
			now,
			nextActionId: repository.newId('next_action'),
			intentId: repository.newId('intent'),
		})
		return {
			mode: 'dry-run',
			idempotentNoop: true,
			contact: identity.contact,
			providerIdentity: identity.providerIdentity,
			contactEvent: existingEvent,
			classification,
			contactState: state,
			nextAction: planned.nextAction,
			sideEffectIntents: planned.sideEffectIntents,
			privacy: { rawPayloadIncluded: false, payloadSummaryOnly: true },
		}
	}

	const event = repository.createContactEvent({
		...normalized,
		contactId: identity.contact.id,
		providerIdentityId: identity.providerIdentity.id,
		createdAt: now,
	})
	const classification = classifyContactEvent(normalized)
	const previousState = repository.findCurrentContactState(identity.contact.id)
	const state = repository.upsertContactState(
		reduceContactState({
			existingState: previousState,
			event,
			classification,
			now,
			id: repository.newId('state'),
		}),
	)
	const transition = repository.createStateTransition({
		contactId: identity.contact.id,
		fromStateId: previousState?.id,
		toStateId: state.id,
		eventId: event.id,
		signals: classification,
		rationale: classification.rationale,
		createdAt: now,
	})
	const planned = planDryRunIntents({
		state,
		event,
		now,
		nextActionId: repository.newId('next_action'),
		intentId: repository.newId('intent'),
	})
	repository.createNextAction(planned.nextAction)
	planned.sideEffectIntents.forEach((intent) =>
		repository.createSideEffectIntent(intent),
	)
	return {
		mode: 'dry-run',
		idempotentNoop: false,
		contact: identity.contact,
		providerIdentity: identity.providerIdentity,
		contactEvent: event,
		classification,
		contactState: state,
		stateTransition: transition,
		nextAction: planned.nextAction,
		sideEffectIntents: planned.sideEffectIntents,
		privacy: { rawPayloadIncluded: false, payloadSummaryOnly: true },
	}
}
