import type { CaptureMarketingRepository } from './capture-contact-event'
import { CONTACT_EVENT_SCHEMA_VERSION, type Gate } from './types'
import {
	evaluateGateDRuntimeAllowlist,
	gateDActionReviewReasons,
	resolveGateDPreAuthorizedReviewReasons,
	type GateDRuntimeAllowlist,
} from './value-path-gate-d-allowlist'
import {
	applyAcceptedValuePathSendGateReviewReasons,
	evaluateValuePathEmailSendGate,
	shouldBlockValuePathForContactState,
	type ValuePathSendGateMode,
} from './value-path-send-gate'

export type ValuePathGateDStartRepository = Pick<
	CaptureMarketingRepository,
	| 'newId'
	| 'findContactById'
	| 'findCurrentContactState'
	| 'findProviderIdentity'
	| 'createProviderIdentity'
	| 'findContactEventBySemanticKey'
	| 'createContactEvent'
	| 'createNextAction'
	| 'findSideEffectIntentByIdempotencyKey'
	| 'createSideEffectIntent'
>

export type ValuePathGateDStartResult = {
	mode: 'dry-run' | 'allow-write'
	activationId: string
	valuePathSlug: string
	emailResourceId: string
	kitSequenceId: string
	counts: {
		candidates: number
		planned: number
		blocked: number
		idempotentNoop: number
		wouldCreate: number
		created: number
	}
	results: ValuePathGateDStartContactResult[]
}

export type ValuePathGateDStartContactResult = {
	contactId: string
	kitSubscriberId?: string
	status: 'planned' | 'blocked' | 'idempotent-noop'
	reviewReasons: string[]
	contactEventId?: string
	nextActionId?: string
	sideEffectIntentId?: string
}

export async function startValuePathGateDActivation(args: {
	repository: ValuePathGateDStartRepository
	allowlist: GateDRuntimeAllowlist
	allowWrite: boolean
	valuePathSlug: string
	emailResourceId: string
	kitSequenceId: string
	acceptedReviewReasons?: string[]
	now?: string
}): Promise<ValuePathGateDStartResult> {
	const now = args.now ?? new Date().toISOString()
	const results: ValuePathGateDStartContactResult[] = []
	for (const candidate of args.allowlist.candidates) {
		results.push(
			await startValuePathGateDContact({
				...args,
				now,
				contactId: candidate.contactId,
				kitSubscriberId: candidate.kitSubscriberId,
				email: candidate.email,
			}),
		)
	}
	return {
		mode: args.allowWrite ? 'allow-write' : 'dry-run',
		activationId: args.allowlist.activationId,
		valuePathSlug: args.valuePathSlug,
		emailResourceId: args.emailResourceId,
		kitSequenceId: args.kitSequenceId,
		counts: {
			candidates: args.allowlist.candidates.length,
			planned: results.filter((result) => result.status === 'planned').length,
			blocked: results.filter((result) => result.status === 'blocked').length,
			idempotentNoop: results.filter(
				(result) => result.status === 'idempotent-noop',
			).length,
			wouldCreate: args.allowWrite
				? 0
				: results.filter((result) => result.status === 'planned').length,
			created: args.allowWrite
				? results.filter((result) => result.status === 'planned').length
				: 0,
		},
		results,
	}
}

async function startValuePathGateDContact(args: {
	repository: ValuePathGateDStartRepository
	allowlist: GateDRuntimeAllowlist
	allowWrite: boolean
	valuePathSlug: string
	emailResourceId: string
	kitSequenceId: string
	acceptedReviewReasons?: string[]
	now: string
	contactId: string
	kitSubscriberId?: string
	email?: string
}): Promise<ValuePathGateDStartContactResult> {
	const contact = await args.repository.findContactById(args.contactId)
	const state = contact
		? await args.repository.findCurrentContactState(contact.id)
		: undefined
	const email = contact?.email?.trim().toLowerCase() ?? args.email
	const preflightReasons = [
		...(contact ? [] : ['contact-missing']),
		...(state ? [] : ['contact-state-missing']),
		...(email ? [] : ['contact-email-missing']),
	]
	const runtimeDecision = evaluateGateDRuntimeAllowlist({
		allowlist: args.allowlist,
		contactId: args.contactId,
		kitSubscriberId: args.kitSubscriberId,
		email,
		valuePathSlug: args.valuePathSlug,
		emailResourceId: args.emailResourceId,
		kitSequenceId: args.kitSequenceId,
	})
	const acceptedReviewReasons = resolveGateDPreAuthorizedReviewReasons({
		allowlist: args.allowlist,
		explicitReviewReasons: args.acceptedReviewReasons,
	})
	const sendDecision = applyAcceptedValuePathSendGateReviewReasons(
		evaluateValuePathEmailSendGate({
			mode: args.allowlist.mode as ValuePathSendGateMode,
			contactId: args.contactId,
			kitSubscriberId: args.kitSubscriberId,
			email,
			valuePathSlug: args.valuePathSlug,
			emailResourceId: args.emailResourceId,
			kitSequenceId: args.kitSequenceId,
			humanReview: shouldBlockValuePathForContactState(state),
			lifecycle: state?.lifecycle,
			reviewSignals: state?.reviewSignals,
			allowlistedContactIds: args.allowlist.contactIds,
			allowlistedKitSubscriberIds: args.allowlist.kitSubscriberIds,
			allowlistedEmails: args.allowlist.emails,
		}),
		acceptedReviewReasons,
	)
	const reviewReasons = unique([
		...preflightReasons,
		...gateDActionReviewReasons({
			allowlist: args.allowlist,
			requiredActions: ['send-path-emails'],
		}),
		...runtimeDecision.reviewReasons,
		...sendDecision.reviewReasons,
	])
	const gates: Gate[] = [
		...(runtimeDecision.passed
			? [
					{
						slug: 'gate-d-value-path-email' as const,
						passed: true,
						reason: 'Gate D Runtime Allowlist passed.',
					},
				]
			: [
					{
						slug: 'gate-d-value-path-email' as const,
						passed: false,
						reason: `Gate D Runtime Allowlist blocked: ${runtimeDecision.reviewReasons.join(', ')}`,
					},
				]),
		...sendDecision.gates,
	]
	if (!contact || !state || !email || reviewReasons.length > 0) {
		return {
			contactId: args.contactId,
			kitSubscriberId: args.kitSubscriberId,
			status: 'blocked',
			reviewReasons,
		}
	}

	const eventKey = `contact:${contact.id}:value-path:${args.valuePathSlug}:start:${args.emailResourceId}`
	const existingEvent =
		await args.repository.findContactEventBySemanticKey(eventKey)
	const idempotencyKey = `contact:${contact.id}:value-path:${args.valuePathSlug}:email:${args.emailResourceId}`
	const existingIntent =
		await args.repository.findSideEffectIntentByIdempotencyKey(idempotencyKey)
	if (existingEvent || existingIntent) {
		return {
			contactId: contact.id,
			kitSubscriberId: args.kitSubscriberId,
			status: 'idempotent-noop',
			reviewReasons: existingIntent?.reviewReasons ?? [],
			contactEventId: existingEvent?.id,
			sideEffectIntentId: existingIntent?.id,
		}
	}
	if (!args.allowWrite) {
		return {
			contactId: contact.id,
			kitSubscriberId: args.kitSubscriberId,
			status: 'planned',
			reviewReasons: [],
		}
	}

	let identity = await args.repository.findProviderIdentity(
		'ai-hero',
		contact.id,
	)
	if (!identity) {
		identity = await args.repository.createProviderIdentity({
			contactId: contact.id,
			provider: 'ai-hero',
			externalId: contact.id,
			evidence: {
				source: 'ai-hero',
				strength: 'strong',
				providerIdentity: { provider: 'ai-hero', externalId: contact.id },
			},
			createdAt: args.now,
			updatedAt: args.now,
		})
	}
	const event = await args.repository.createContactEvent({
		contactId: contact.id,
		providerIdentityId: identity.id,
		provider: 'ai-hero',
		providerEventId: eventKey,
		providerReference: `value-path:${args.valuePathSlug}`,
		eventType: 'value-path.entered',
		occurredAt: args.now,
		semanticIdempotencyKey: eventKey,
		privacyLevel: 'internal',
		identityEvidence: identity.evidence,
		payloadSummary: {
			summary: `Entered value path ${args.valuePathSlug} at ${args.emailResourceId}`,
			keywords: [
				'value-path',
				'entered',
				args.valuePathSlug,
				args.emailResourceId,
			],
			restrictedPayloadStored: false,
		},
		schemaVersion: CONTACT_EVENT_SCHEMA_VERSION,
		createdAt: args.now,
	})
	const nextAction = await args.repository.createNextAction({
		id: args.repository.newId('next_action'),
		contactId: contact.id,
		contactStateId: state.id,
		eventId: event.id,
		type: 'enter-value-path',
		status: 'planned',
		gates,
		reviewReasons: [],
		rationale: [
			`Start value path ${args.valuePathSlug} with ${args.emailResourceId}.`,
			...runtimeDecision.rationale,
			...sendDecision.rationale,
		],
		createdAt: args.now,
	})
	const intent = await args.repository.createSideEffectIntent({
		id: args.repository.newId('side_effect_intent'),
		nextActionId: nextAction.id,
		contactId: contact.id,
		provider: 'kit',
		type: 'send-value-path-email',
		status: 'pending',
		idempotencyKey,
		gates,
		reviewReasons: [],
		metadata: {
			gate: 'send-gate-d-value-path-email',
			activationId: args.allowlist.activationId,
			mode: args.allowlist.mode,
			valuePathSlug: args.valuePathSlug,
			emailResourceId: args.emailResourceId,
			kitSubscriberId: args.kitSubscriberId ?? null,
			kitSequenceId: args.kitSequenceId,
			providerResult: null,
		},
		createdAt: args.now,
	})
	return {
		contactId: contact.id,
		kitSubscriberId: args.kitSubscriberId,
		status: 'planned',
		reviewReasons: [],
		contactEventId: event.id,
		nextActionId: nextAction.id,
		sideEffectIntentId: intent.id,
	}
}

function unique(values: string[]) {
	return Array.from(new Set(values))
}
