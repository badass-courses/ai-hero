import { planInternalCaptureIntents } from './intent-planner'
import { classifyContactEvent } from './signal-classifier'
import { reduceContactState } from './state-reducer'
import type {
	ContactEventRecord,
	ContactRecord,
	ContactState,
	DryRunInspection,
	NextAction,
	NormalizedContactEvent,
	ProviderIdentityRecord,
	SideEffectIntent,
	StateTransition,
} from './types'

type MaybePromise<T> = T | Promise<T>

export type CaptureMarketingRepository = {
	findProviderIdentity(
		provider: string,
		externalId: string,
	): MaybePromise<ProviderIdentityRecord | undefined>
	findContactById(id: string): MaybePromise<ContactRecord | undefined>
	findContactByEmail(email: string): MaybePromise<ContactRecord | undefined>
	createContact(input: Omit<ContactRecord, 'id'>): MaybePromise<ContactRecord>
	updateContactOptInAttribution?(contactId: string, attribution: NonNullable<ContactRecord['optInAttribution']>): MaybePromise<ContactRecord>
	createProviderIdentity(
		input: Omit<ProviderIdentityRecord, 'id'>,
	): MaybePromise<ProviderIdentityRecord>
	linkProviderIdentityToContact(
		identityId: string,
		contactId: string,
	): MaybePromise<ProviderIdentityRecord>
	findContactEventBySemanticKey(
		key: string,
	): MaybePromise<ContactEventRecord | undefined>
	findContactEventsByType?(
		contactId: string,
		eventType: string,
	): MaybePromise<ContactEventRecord[]>
	createContactEvent(
		input: Omit<ContactEventRecord, 'id' | 'createdAt'> & {
			createdAt?: string
		},
	): MaybePromise<ContactEventRecord>
	findCurrentContactState(
		contactId: string,
	): MaybePromise<ContactState | undefined>
	upsertContactState(state: ContactState): MaybePromise<ContactState>
	createStateTransition(
		input: Omit<StateTransition, 'id'>,
	): MaybePromise<StateTransition>
	createNextAction(input: NextAction): MaybePromise<NextAction>
	findSideEffectIntentByIdempotencyKey(
		idempotencyKey: string,
	): MaybePromise<SideEffectIntent | undefined>
	createSideEffectIntent(
		input: SideEffectIntent,
	): MaybePromise<SideEffectIntent>
	findPendingValuePathEmailSideEffectIntents?(args: {
		limit: number
	}): MaybePromise<SideEffectIntent[]>
	findCompletedValuePathEmailSideEffectIntents?(args: {
		limit: number
		maxCompletedAt?: string
	}): MaybePromise<SideEffectIntent[]>
	findValuePathEmailSideEffectIntentsByContact?(
		contactId: string,
	): MaybePromise<SideEffectIntent[]>
	updateSideEffectIntent?(
		id: string,
		patch: Pick<
			SideEffectIntent,
			'status' | 'gates' | 'reviewReasons' | 'metadata'
		> & Pick<SideEffectIntent, 'completedAt'>,
	): MaybePromise<SideEffectIntent>
	newId(kind: string): string
}

export async function captureNormalizedContactEvent(args: {
	repository: CaptureMarketingRepository
	event: NormalizedContactEvent
	now?: string
}): Promise<DryRunInspection> {
	const now = args.now ?? new Date().toISOString()
	const existingEvent = await args.repository.findContactEventBySemanticKey(
		args.event.semanticIdempotencyKey,
	)
	const identity = await resolveOrCreateCaptureIdentity({
		repository: args.repository,
		event: args.event,
		now,
	})

	if (existingEvent) {
		const existingState = await args.repository.findCurrentContactState(
			identity.contact.id,
		)
		const classification = classifyContactEvent(args.event)
		const state =
			existingState ??
			reduceContactState({
				event: existingEvent,
				classification,
				now,
				id: args.repository.newId('state'),
			})
		const planned = planInternalCaptureIntents({
			state,
			event: existingEvent,
			now,
			nextActionId: args.repository.newId('next_action'),
			intentId: args.repository.newId('intent'),
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

	const event = await args.repository.createContactEvent({
		...args.event,
		contactId: identity.contact.id,
		providerIdentityId: identity.providerIdentity.id,
		createdAt: now,
	})
	const classification = classifyContactEvent(args.event)
	const previousState = await args.repository.findCurrentContactState(
		identity.contact.id,
	)
	const state = await args.repository.upsertContactState(
		reduceContactState({
			existingState: previousState,
			event,
			classification,
			now,
			id: previousState?.id ?? args.repository.newId('state'),
		}),
	)
	const transition = await args.repository.createStateTransition({
		contactId: identity.contact.id,
		fromStateId: previousState?.id,
		toStateId: state.id,
		eventId: event.id,
		signals: classification,
		rationale: classification.rationale,
		createdAt: now,
	})
	const planned = planInternalCaptureIntents({
		state,
		event,
		now,
		nextActionId: args.repository.newId('next_action'),
		intentId: args.repository.newId('intent'),
	})
	await args.repository.createNextAction(planned.nextAction)
	for (const intent of planned.sideEffectIntents) {
		await args.repository.createSideEffectIntent(intent)
	}

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

async function resolveOrCreateCaptureIdentity(args: {
	repository: CaptureMarketingRepository
	event: NormalizedContactEvent
	now: string
}) {
	const evidence = args.event.identityEvidence
	const providerIdentityEvidence = evidence.providerIdentity
	if (!providerIdentityEvidence) {
		throw new Error('Normalized event missing provider identity evidence')
	}

	const existingIdentity = await args.repository.findProviderIdentity(
		providerIdentityEvidence.provider,
		providerIdentityEvidence.externalId,
	)
	if (existingIdentity) {
		const contact = await args.repository.findContactById(
			existingIdentity.contactId,
		)
		if (!contact) {
			throw new Error(
				`Provider identity ${existingIdentity.id} points at missing contact`,
			)
		}
		const attributedContact =
			!contact.optInAttribution && args.event.optInAttribution && args.repository.updateContactOptInAttribution
				? await args.repository.updateContactOptInAttribution(contact.id, args.event.optInAttribution)
				: contact
		return {
			contact: attributedContact,
			providerIdentity: existingIdentity,
			createdContact: false,
			createdProviderIdentity: false,
		}
	}

	const contact = await args.repository.createContact({
		userId: evidence.userId ?? null,
		email: evidence.email ?? null,
		name: evidence.name ?? null,
		lifecycle: 'new',
		isProvisional: true,
		optInAttribution: args.event.optInAttribution ?? null,
		createdAt: args.now,
		updatedAt: args.now,
	})
	const providerIdentity = await args.repository.createProviderIdentity({
		contactId: contact.id,
		provider: providerIdentityEvidence.provider,
		externalId: providerIdentityEvidence.externalId,
		evidence,
		createdAt: args.now,
		updatedAt: args.now,
	})

	return {
		contact,
		providerIdentity,
		createdContact: true,
		createdProviderIdentity: true,
	}
}
