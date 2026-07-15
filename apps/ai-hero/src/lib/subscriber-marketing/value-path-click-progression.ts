import type { CaptureMarketingRepository } from './capture-contact-event'
import type { ValuePathTokenPayload } from './path-token'
import { CONTACT_EVENT_SCHEMA_VERSION } from './types'
import { MAX_PLAUSIBLE_ANSWER_CLICKS_PER_CONTACT } from './value-path-answer-click-verification'
import type { ValuePathAnswerPageResource } from './value-path-answer-page'
import { gateDActionReviewReasons } from './value-path-gate-d-allowlist'
import {
	applyAcceptedValuePathSendGateReviewReasons,
	evaluateValuePathEmailSendGate,
	shouldBlockValuePathForContactState,
	type ValuePathSendGateInput,
	type ValuePathSendGateMode,
} from './value-path-send-gate'

export type ValuePathAnswerProgressionResult =
	| {
			status: 'recorded'
			contactEventId: string
			nextActionId: string
			sideEffectIntentId: string
			idempotentNoop: false
			reviewReasons: string[]
	  }
	| {
			status: 'idempotent-noop'
			contactEventId: string
			sideEffectIntentId?: string
			idempotentNoop: true
			reviewReasons: string[]
	  }
	| {
			status: 'skipped'
			reason: string
			idempotentNoop: false
			reviewReasons: string[]
	  }

export type ValuePathAnswerProgressionGateConfig = Pick<
	ValuePathSendGateInput,
	| 'allowlistedContactIds'
	| 'allowlistedKitSubscriberIds'
	| 'allowlistedEmails'
	| 'enabledValuePathSlugs'
	| 'verifiedEmailResourceIds'
	| 'verifiedKitSequenceIds'
> & {
	allowedActions?: readonly string[]
}

export async function recordValuePathAnswerProgression(args: {
	repository: CaptureMarketingRepository
	token: ValuePathTokenPayload
	answerPage: ValuePathAnswerPageResource
	mode?: ValuePathSendGateMode
	sendGate?: ValuePathAnswerProgressionGateConfig
	acceptedReviewReasons?: string[]
	now?: string
}): Promise<ValuePathAnswerProgressionResult> {
	const now = args.now ?? new Date().toISOString()
	const fields = args.answerPage.fields
	const nextEmailResourceId = fields.nextEmailResourceId
	const nextValuePathSlug =
		fields.nextSequenceId ?? args.token.valuePathResourceId
	if (!nextEmailResourceId) {
		return {
			status: 'skipped',
			reason: 'next-email-resource-missing',
			idempotentNoop: false,
			reviewReasons: ['next-email-resource-missing'],
		}
	}

	const contact = await args.repository.findContactById(args.token.contactId)
	if (!contact) {
		return {
			status: 'skipped',
			reason: 'contact-missing',
			idempotentNoop: false,
			reviewReasons: ['contact-missing'],
		}
	}
	const state = await args.repository.findCurrentContactState(contact.id)
	if (!state) {
		return {
			status: 'skipped',
			reason: 'contact-state-missing',
			idempotentNoop: false,
			reviewReasons: ['contact-state-missing'],
		}
	}

	const eventKey = `contact:${contact.id}:value-path:${args.token.valuePathResourceId}:answer:${args.answerPage.id}`
	const existingEvent =
		await args.repository.findContactEventBySemanticKey(eventKey)
	const idempotencyKey = `contact:${contact.id}:value-path:${args.token.valuePathResourceId}:email:${nextEmailResourceId}`
	const existingIntent =
		await args.repository.findSideEffectIntentByIdempotencyKey(idempotencyKey)
	if (existingEvent) {
		return {
			status: 'idempotent-noop',
			contactEventId: existingEvent.id,
			sideEffectIntentId: existingIntent?.id,
			idempotentNoop: true,
			reviewReasons: existingIntent?.reviewReasons ?? [],
		}
	}

	if (args.repository.findContactEventsByType) {
		const priorClicks = await args.repository.findContactEventsByType(
			contact.id,
			'value-path.answer-selected',
		)
		if (priorClicks.length >= MAX_PLAUSIBLE_ANSWER_CLICKS_PER_CONTACT) {
			// Email security scanners click every /ask link; a contact past the
			// organic ceiling must not keep advancing progression by clicks.
			return {
				status: 'skipped',
				reason: 'answer-click-volume-implausible',
				idempotentNoop: false,
				reviewReasons: ['answer-click-volume-implausible'],
			}
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
			createdAt: now,
			updatedAt: now,
		})
	}

	const event = await args.repository.createContactEvent({
		contactId: contact.id,
		providerIdentityId: identity.id,
		provider: 'ai-hero',
		providerEventId: eventKey,
		providerReference: `/ask/${fields.slug}`,
		eventType: 'value-path.answer-selected',
		occurredAt: now,
		semanticIdempotencyKey: eventKey,
		privacyLevel: 'internal',
		identityEvidence: identity.evidence,
		payloadSummary: {
			summary: `Selected answer ${fields.optionValue ?? 'unknown'} for ${fields.surveyId ?? 'unknown survey'}`,
			keywords: [
				'value-path',
				'answer-selected',
				fields.sequenceId ?? args.token.sequenceId,
				fields.optionValue ?? 'unknown-option',
			].filter(Boolean),
			restrictedPayloadStored: false,
		},
		schemaVersion: CONTACT_EVENT_SCHEMA_VERSION,
		createdAt: now,
	})

	const gate = applyAcceptedValuePathSendGateReviewReasons(
		evaluateValuePathEmailSendGate({
			mode: args.mode ?? 'dry-run',
			contactId: contact.id,
			kitSubscriberId: args.token.kitSubscriberId,
			email: contact.email ?? undefined,
			valuePathSlug: nextValuePathSlug,
			emailResourceId: nextEmailResourceId,
			kitSequenceId: stringField(fields.kitSequenceId),
			humanReview: shouldBlockValuePathForContactState(state),
			lifecycle: state.lifecycle,
			reviewSignals: state.reviewSignals,
			...args.sendGate,
		}),
		args.acceptedReviewReasons ?? [],
	)

	const reviewReasons = unique([
		...gate.reviewReasons,
		...gateDActionReviewReasons({
			allowedActions: args.sendGate?.allowedActions,
			requiredActions: ['advance-by-answer-click', 'send-path-emails'],
		}),
	])
	const nextAction = await args.repository.createNextAction({
		id: args.repository.newId('next_action'),
		contactId: contact.id,
		contactStateId: state.id,
		eventId: event.id,
		type: 'advance-value-path',
		status: reviewReasons.length === 0 ? 'planned' : 'blocked',
		gates: gate.gates,
		reviewReasons,
		rationale: [
			`Advance value path after answer page ${args.answerPage.id}.`,
			...gate.rationale,
		],
		createdAt: now,
	})

	const intent =
		existingIntent ??
		(await args.repository.createSideEffectIntent({
			id: args.repository.newId('side_effect_intent'),
			nextActionId: nextAction.id,
			contactId: contact.id,
			provider: 'kit',
			type: 'send-value-path-email',
			status:
				gate.mode === 'dry-run'
					? 'dry-run'
					: reviewReasons.length === 0
						? 'pending'
						: 'blocked',
			idempotencyKey,
			gates: gate.gates,
			reviewReasons,
			metadata: {
				gate: 'send-gate-d-value-path-email',
				mode: gate.mode,
				valuePathSlug: nextValuePathSlug,
				emailResourceId: nextEmailResourceId,
				kitSubscriberId: args.token.kitSubscriberId ?? null,
				answerPageId: args.answerPage.id,
				surveyId: fields.surveyId,
				optionValue: fields.optionValue,
				nextEmailId: fields.nextEmailId,
				nextEmailResourceId,
				kitSequenceId: stringField(fields.kitSequenceId) ?? null,
				providerResult: null,
			},
			createdAt: now,
		}))

	return {
		status: 'recorded',
		contactEventId: event.id,
		nextActionId: nextAction.id,
		sideEffectIntentId: intent.id,
		idempotentNoop: false,
		reviewReasons,
	}
}

function unique(values: string[]) {
	return Array.from(new Set(values))
}

function stringField(value: unknown) {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}
