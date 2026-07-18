import type { CaptureMarketingRepository } from './capture-contact-event'
import type { ValuePathTokenPayload } from './path-token'
import { CONTACT_EVENT_SCHEMA_VERSION } from './types'
import { MAX_PLAUSIBLE_ANSWER_CLICKS_PER_CONTACT } from './value-path-answer-click-verification'
import type { ValuePathAnswerPageResource } from './value-path-answer-page'
import { getSkillsWorkflowEmailStep } from './skills-workflow-path'
import {
	captureValuePathFinisherFields,
	type ValuePathFinisherCaptureResult,
	type ValuePathFinisherFieldProvider,
} from './value-path-finisher-capture'
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
			nextActionId?: string
			sideEffectIntentId?: string
			finisherCapture?: ValuePathFinisherCaptureResult['status']
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
	finisherFieldProvider?: ValuePathFinisherFieldProvider
	acceptedReviewReasons?: string[]
	now?: string
}): Promise<ValuePathAnswerProgressionResult> {
	const now = args.now ?? new Date().toISOString()
	const fields = args.answerPage.fields
	const tokenEmailId = emailIdFromResourceId(args.token.emailResourceId)
	if (fields.emailId && fields.emailId !== tokenEmailId) {
		return {
			status: 'skipped',
			reason: 'answer-page-token-email-mismatch',
			idempotentNoop: false,
			reviewReasons: ['answer-page-token-email-mismatch'],
		}
	}
	if (fields.sequenceId && fields.sequenceId !== args.token.sequenceId) {
		return {
			status: 'skipped',
			reason: 'answer-page-token-sequence-mismatch',
			idempotentNoop: false,
			reviewReasons: ['answer-page-token-sequence-mismatch'],
		}
	}
	const nextEmailResourceId = fields.nextEmailResourceId
	const nextValuePathSlug =
		fields.nextSequenceId ?? args.token.valuePathResourceId
	const capturesFinisher = Boolean(
		fields.captureFieldKey || fields.captureDateFieldKey,
	)
	if (capturesFinisher && (!fields.emailId || !fields.sequenceId)) {
		return {
			status: 'skipped',
			reason: 'finisher-capture-token-binding-missing',
			idempotentNoop: false,
			reviewReasons: ['finisher-capture-token-binding-missing'],
		}
	}
	if (!nextEmailResourceId && !capturesFinisher) {
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
	const idempotencyKey = nextEmailResourceId
		? `contact:${contact.id}:value-path:${args.token.valuePathResourceId}:email:${nextEmailResourceId}`
		: undefined
	const finisherIdempotencyKey = capturesFinisher
		? `${eventKey}:write-finisher-fields`
		: undefined
	const existingIntent = idempotencyKey
		? await args.repository.findSideEffectIntentByIdempotencyKey(idempotencyKey)
		: finisherIdempotencyKey
			? await args.repository.findSideEffectIntentByIdempotencyKey(
					finisherIdempotencyKey,
				)
			: undefined
	if (
		existingEvent &&
		(!capturesFinisher ||
			existingIntent?.status === 'pending' ||
			existingIntent?.status === 'completed' ||
			existingIntent?.status === 'dry-run')
	) {
		return {
			status: 'idempotent-noop',
			contactEventId: existingEvent.id,
			sideEffectIntentId: existingIntent?.id,
			idempotentNoop: true,
			reviewReasons:
				existingIntent?.status === 'pending'
					? unique([
							...existingIntent.reviewReasons,
							'finisher-capture-in-progress',
						])
					: (existingIntent?.reviewReasons ?? []),
		}
	}

	if (!existingEvent && args.repository.findContactEventsByType) {
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

	const captureStep = capturesFinisher
		? getSkillsWorkflowEmailStep(args.token.emailResourceId)
		: undefined
	const captureGate = capturesFinisher
		? applyAcceptedValuePathSendGateReviewReasons(
				evaluateValuePathEmailSendGate({
					mode: args.mode ?? 'dry-run',
					contactId: contact.id,
					kitSubscriberId: args.token.kitSubscriberId,
					email: contact.email ?? undefined,
					valuePathSlug:
						fields.sequenceId ?? args.token.valuePathResourceId,
					emailResourceId: args.token.emailResourceId,
					kitSequenceId: captureStep?.kitSequenceId,
					humanReview: shouldBlockValuePathForContactState(state),
					lifecycle: state.lifecycle,
					reviewSignals: state.reviewSignals,
					...args.sendGate,
				}),
				args.acceptedReviewReasons ?? [],
			)
		: undefined
	const captureReviewReasons = capturesFinisher
		? unique([
				...(captureGate?.reviewReasons ?? []),
				...gateDActionReviewReasons({
					allowedActions: args.sendGate?.allowedActions,
					requiredActions: ['advance-by-answer-click'],
				}),
			])
		: []
	if (captureReviewReasons.length > 0) {
		return {
			status: 'skipped',
			reason: 'finisher-capture-action-not-authorized',
			idempotentNoop: false,
			reviewReasons: captureReviewReasons,
		}
	}
	if (
		capturesFinisher &&
		args.mode !== 'dry-run' &&
		!args.repository.updateSideEffectIntent
	) {
		return {
			status: 'skipped',
			reason: 'finisher-capture-repository-update-missing',
			idempotentNoop: false,
			reviewReasons: ['finisher-capture-repository-update-missing'],
		}
	}

	const event =
		existingEvent ??
		(await args.repository.createContactEvent({
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
	}))

	if (!nextEmailResourceId) {
		const selectedAt = stringField(existingIntent?.metadata.selectedAt) ?? event.occurredAt
		const nextAction =
			existingIntent === undefined
				? await args.repository.createNextAction({
						id: args.repository.newId('next_action'),
						contactId: contact.id,
						contactStateId: state.id,
						eventId: event.id,
						type: 'set-shadow-fields',
						status: 'planned',
						gates: captureGate?.gates ?? [],
						reviewReasons: [],
						rationale: [
							`Capture terminal finisher fields after answer page ${args.answerPage.id}.`,
							...(captureGate?.rationale ?? []),
						],
						createdAt: selectedAt,
					})
				: undefined
		const intent =
			existingIntent ??
			(await args.repository.createSideEffectIntent({
				id: args.repository.newId('side_effect_intent'),
				nextActionId: nextAction!.id,
				contactId: contact.id,
				provider: args.mode === 'dry-run' ? 'dry-run' : 'kit',
				type: 'write-value-path-finisher-fields',
				status: args.mode === 'dry-run' ? 'dry-run' : 'pending',
				idempotencyKey: finisherIdempotencyKey!,
				gates: captureGate?.gates ?? [],
				reviewReasons: [],
				metadata: {
					gate: 'gate-d-value-path-finisher-capture',
					mode: args.mode ?? 'dry-run',
					valuePathSlug: args.token.valuePathResourceId,
					emailResourceId: args.token.emailResourceId,
					kitSubscriberId: args.token.kitSubscriberId ?? null,
					answerPageId: args.answerPage.id,
					surveyId: fields.surveyId,
					optionValue: fields.optionValue,
					captureFieldKey: fields.captureFieldKey,
					captureDateFieldKey: fields.captureDateFieldKey,
					selectedAt,
					providerResult: null,
				},
				createdAt: selectedAt,
			}))
		let finisherCapture: ValuePathFinisherCaptureResult
		try {
			finisherCapture = await captureValuePathFinisherFields({
				provider: args.finisherFieldProvider,
				mode: args.mode ?? 'dry-run',
				email: contact.email,
				kitSubscriberId: args.token.kitSubscriberId,
				optionValue: fields.optionValue,
				captureFieldKey: fields.captureFieldKey,
				captureDateFieldKey: fields.captureDateFieldKey,
				now: selectedAt,
			})
		} catch (error) {
			await args.repository.updateSideEffectIntent?.(intent.id, {
				status: 'failed',
				completedAt: null,
				gates: intent.gates,
				reviewReasons: ['kit-finisher-field-write-failed'],
				metadata: {
					...intent.metadata,
					providerResult: {
						status: 'failed',
						message: error instanceof Error ? error.message : String(error),
					},
				},
			})
			throw error
		}
		if (finisherCapture.status === 'blocked') {
			await args.repository.updateSideEffectIntent?.(intent.id, {
				status: 'blocked',
				completedAt: null,
				gates: intent.gates,
				reviewReasons: finisherCapture.reviewReasons,
				metadata: {
					...intent.metadata,
					providerResult: { status: finisherCapture.status },
				},
			})
			return {
				status: 'skipped',
				reason: 'finisher-capture-blocked',
				idempotentNoop: false,
				reviewReasons: finisherCapture.reviewReasons,
			}
		}
		if (finisherCapture.status !== 'dry-run') {
			await args.repository.updateSideEffectIntent?.(intent.id, {
				status: 'completed',
				completedAt: selectedAt,
				gates: intent.gates,
				reviewReasons:
					'reviewReasons' in finisherCapture
						? finisherCapture.reviewReasons
						: [],
				metadata: {
					...intent.metadata,
					providerResult: { status: finisherCapture.status },
				},
			})
		}
		return {
			status: 'recorded',
			contactEventId: event.id,
			nextActionId: nextAction?.id ?? intent.nextActionId,
			sideEffectIntentId: intent.id,
			finisherCapture: finisherCapture.status,
			idempotentNoop: false,
			reviewReasons:
				finisherCapture.status === 'excluded'
					? finisherCapture.reviewReasons
					: [],
		}
	}

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
			idempotencyKey: idempotencyKey!,
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

function emailIdFromResourceId(resourceId: string) {
	const parts = resourceId.split('.')
	return parts[parts.length - 1]
}

function stringField(value: unknown) {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}
