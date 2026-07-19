import { log } from '@/server/logger'

import type { CaptureMarketingRepository } from './capture-contact-event'
import { evaluateEmail7LaunchGate } from './email-7-launch-gate'
import {
	SKILLS_WORKFLOW_EMAIL_STEPS,
	type SkillsWorkflowEmailStep,
} from './skills-workflow-path'
import {
	CONTACT_EVENT_SCHEMA_VERSION,
	type Gate,
	type SideEffectIntent,
} from './types'
import {
	isValuePathIntentCompleted,
	valuePathIntentCompletedAt,
} from './value-path-completion'
import { isLocalDayDripDue } from './value-path-drip-due'

export { isLocalDayDripDue } from './value-path-drip-due'
import {
	verifyAnswerClickForStep,
	type AnswerClickVerification,
} from './value-path-answer-click-verification'
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
} from './value-path-send-gate'

export { SKILLS_WORKFLOW_EMAIL_STEPS }
export type { SkillsWorkflowEmailStep }

export type ValuePathDripProgressionRepository = Pick<
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
> & {
	findContactEventsByType?: (
		contactId: string,
		eventType: string,
	) =>
		| Promise<CaptureMarketingRepositoryContactEvent[]>
		| CaptureMarketingRepositoryContactEvent[]
	findValuePathEmailSideEffectIntentsByContact?: (
		contactId: string,
	) => Promise<SideEffectIntent[]> | SideEffectIntent[]
}

type CaptureMarketingRepositoryContactEvent =
	Awaited<
		ReturnType<CaptureMarketingRepository['findContactEventBySemanticKey']>
	> extends infer Event
		? Exclude<Event, undefined>
		: never

export type ValuePathDripProgressionResult = {
	mode: 'dry-run' | 'allow-write'
	counts: {
		completedIntents: number
		planned: number
		blocked: number
		terminal: number
		idempotentNoop: number
		notDue: number
		deferred: number
	}
	results: ValuePathDripProgressionContactResult[]
}

export type ValuePathDripProgressionContactResult = {
	contactId: string
	fromEmailResourceId?: string
	nextEmailResourceId?: string
	nextKitSequenceId?: string
	status:
		| 'planned'
		| 'blocked'
		| 'terminal'
		| 'idempotent-noop'
		| 'not-due'
		| 'deferred'
	reviewReasons: string[]
	advisoryReasons?: string[]
	contactEventId?: string
	nextActionId?: string
	sideEffectIntentId?: string
}

export async function progressValuePathDrips(args: {
	repository: ValuePathDripProgressionRepository
	allowlist: GateDRuntimeAllowlist
	completedIntents: SideEffectIntent[]
	allowWrite: boolean
	acceptedReviewReasons?: string[]
	email7LiveEnabled?: boolean
	now?: string
	logger?: Pick<typeof log, 'info' | 'warn'>
}): Promise<ValuePathDripProgressionResult> {
	const now = args.now ?? new Date().toISOString()
	const results: ValuePathDripProgressionContactResult[] = []
	const logger = args.logger ?? log
	for (const intent of args.completedIntents) {
		try {
			results.push(await progressCompletedIntent({ ...args, intent, now }))
		} catch (cause) {
			const fromEmailResourceId = stringField(intent.metadata.emailResourceId)
			await logger.warn('value-path.drip.progression_deferred', {
				fromEmailResourceId,
				errorCategory: 'write-failed',
			})
			results.push({
				contactId: intent.contactId,
				fromEmailResourceId,
				status: 'deferred',
				reviewReasons: ['drip-progression-write-failed'],
			})
		}
	}
	return {
		mode: args.allowWrite ? 'allow-write' : 'dry-run',
		counts: {
			completedIntents: args.completedIntents.length,
			planned: results.filter((result) => result.status === 'planned').length,
			blocked: results.filter((result) => result.status === 'blocked').length,
			terminal: results.filter((result) => result.status === 'terminal').length,
			idempotentNoop: results.filter(
				(result) => result.status === 'idempotent-noop',
			).length,
			notDue: results.filter((result) => result.status === 'not-due').length,
			deferred: results.filter((result) => result.status === 'deferred').length,
		},
		results,
	}
}

async function progressCompletedIntent(args: {
	repository: ValuePathDripProgressionRepository
	allowlist: GateDRuntimeAllowlist
	allowWrite: boolean
	acceptedReviewReasons?: string[]
	email7LiveEnabled?: boolean
	now: string
	intent: SideEffectIntent
	logger?: Pick<typeof log, 'info' | 'warn'>
}): Promise<ValuePathDripProgressionContactResult> {
	const metadata = args.intent.metadata
	const fromEmailResourceId = stringField(metadata.emailResourceId)
	const step = SKILLS_WORKFLOW_EMAIL_STEPS.find(
		(step) => step.emailResourceId === fromEmailResourceId,
	)
	if (!step) {
		return {
			contactId: args.intent.contactId,
			fromEmailResourceId,
			status: 'blocked',
			reviewReasons: ['value-path-step-missing'],
		}
	}
	if (
		!step.nextEmailResourceId ||
		!step.nextKitSequenceId ||
		!step.nextValuePathSlug
	) {
		return {
			contactId: args.intent.contactId,
			fromEmailResourceId,
			status: 'terminal',
			reviewReasons: [],
		}
	}
	const completedAt = valuePathIntentCompletedAt(args.intent)
	const due = isLocalDayDripDue({
		completedAt,
		now: args.now,
		scheduleEvidence: args.allowlist.candidates.find(
			(candidate) => candidate.contactId === args.intent.contactId,
		)?.scheduleEvidence,
		cadenceHours: numberField(metadata.learnerFlowCanaryCadenceHours),
	})
	if (!due.due) {
		return {
			contactId: args.intent.contactId,
			fromEmailResourceId,
			status: 'not-due',
			reviewReasons: [due.reason],
		}
	}
	const clickAdvisories: string[] = []
	const answerClick = await findAnswerClickForCompletedEmail({
		repository: args.repository,
		contactId: args.intent.contactId,
		fromEmailResourceId,
		completedAt,
	})
	const logger = args.logger ?? log
	await logger.info('value-path.ask.answer_click_verification', {
		contactId: args.intent.contactId,
		completedIntentId: args.intent.id,
		fromEmailResourceId,
		verdict: answerClick.verdict,
		...(answerClick.verdict === 'verified'
			? { answerClickEventId: answerClick.event.id }
			: {}),
	})
	if (answerClick.verdict === 'verified') {
		const clickOwned = await findDeliverableIntentSinceClick({
			repository: args.repository,
			contactId: args.intent.contactId,
			clickOccurredAt: answerClick.event.occurredAt,
			excludeIntentId: args.intent.id,
		})
		if (!clickOwned.supported || clickOwned.intent) {
			// The click path owns delivery only when it actually produced a
			// deliverable intent; otherwise the drip must not park the contact
			// (2026-07 regression: 16 clicked-but-undelivered contacts noop'd
			// forever).
			return {
				contactId: args.intent.contactId,
				fromEmailResourceId,
				status: 'idempotent-noop',
				reviewReasons: ['answer-click-already-selected'],
				contactEventId: answerClick.event.id,
				sideEffectIntentId: clickOwned.intent?.id,
			}
		}
		clickAdvisories.push('answer-click-undelivered-drip-fallback')
		await logger.warn(
			'value-path.ask.answer_click_undelivered_drip_fallback',
			{
				contactId: args.intent.contactId,
				completedIntentId: args.intent.id,
				fromEmailResourceId,
				answerClickEventId: answerClick.event.id,
				advisory: 'answer-click-undelivered-drip-fallback',
			},
		)
	} else if (answerClick.verdict !== 'none') {
		// Scanner/bot-like click volume: do not treat the clicks as answers.
		clickAdvisories.push(`answer-click-unverified:${answerClick.verdict}`)
	}

	const nextEmailResourceId = step.nextEmailResourceId
	const nextKitSequenceId = step.nextKitSequenceId
	const nextValuePathSlug = step.nextValuePathSlug
	const idempotencyKey = `contact:${args.intent.contactId}:value-path:${nextValuePathSlug}:email:${nextEmailResourceId}`
	const existingIntent =
		await args.repository.findSideEffectIntentByIdempotencyKey(idempotencyKey)
	if (existingIntent) {
		return {
			contactId: args.intent.contactId,
			fromEmailResourceId,
			nextEmailResourceId,
			nextKitSequenceId,
			status: 'idempotent-noop',
			reviewReasons: existingIntent.reviewReasons,
			sideEffectIntentId: existingIntent.id,
		}
	}

	const contact = await args.repository.findContactById(args.intent.contactId)
	const state = contact
		? await args.repository.findCurrentContactState(contact.id)
		: undefined
	const kitSubscriberId = stringField(metadata.kitSubscriberId)
	const email = contact?.email?.trim().toLowerCase()
	const preflightReasons = [
		...(contact ? [] : ['contact-missing']),
		...(state ? [] : ['contact-state-missing']),
		...(email ? [] : ['contact-email-missing']),
	]
	const runtimeDecision = evaluateGateDRuntimeAllowlist({
		allowlist: args.allowlist,
		contactId: args.intent.contactId,
		kitSubscriberId,
		email,
		valuePathSlug: nextValuePathSlug,
		emailResourceId: nextEmailResourceId,
		kitSequenceId: nextKitSequenceId,
	})
	const acceptedReviewReasons = resolveGateDPreAuthorizedReviewReasons({
		allowlist: args.allowlist,
		explicitReviewReasons: args.acceptedReviewReasons,
	})
	const email7LaunchGate = evaluateEmail7LaunchGate({
		emailResourceId: nextEmailResourceId,
		email,
		liveEnabled: args.email7LiveEnabled,
	})
	const sendDecision = applyAcceptedValuePathSendGateReviewReasons(
		evaluateValuePathEmailSendGate({
			mode: args.allowlist.mode,
			contactId: args.intent.contactId,
			kitSubscriberId,
			email,
			valuePathSlug: nextValuePathSlug,
			emailResourceId: nextEmailResourceId,
			kitSequenceId: nextKitSequenceId,
			humanReview: shouldBlockValuePathForContactState(state),
			lifecycle: state?.lifecycle,
			reviewSignals: state?.reviewSignals,
			allowlistedContactIds: args.allowlist.contactIds,
			allowlistedKitSubscriberIds: args.allowlist.kitSubscriberIds,
			allowlistedEmails: args.allowlist.emails,
			enabledValuePathSlugs: args.allowlist.pathSlugs,
			verifiedEmailResourceIds: args.allowlist.emailResourceIds,
			verifiedKitSequenceIds: args.allowlist.kitSequenceIds,
		}),
		acceptedReviewReasons,
	)
	const reviewReasons = unique([
		...preflightReasons,
		...gateDActionReviewReasons({
			allowlist: args.allowlist,
			requiredActions: ['advance-by-daily-drip', 'send-path-emails'],
		}),
		...runtimeDecision.reviewReasons,
		...email7LaunchGate.reviewReasons,
		...sendDecision.reviewReasons,
	])
	const advisoryReasons = unique([
		...clickAdvisories,
		...(sendDecision.advisoryReasons ?? []),
	])
	const gates: Gate[] = [
		{
			slug: 'gate-d-value-path-email',
			passed: runtimeDecision.passed,
			reason: runtimeDecision.passed
				? 'Gate D Runtime Allowlist passed.'
				: `Gate D Runtime Allowlist blocked: ${runtimeDecision.reviewReasons.join(', ')}`,
		},
		{
			slug: email7LaunchGate.slug,
			passed: email7LaunchGate.passed,
			reason: email7LaunchGate.reason,
		},
		...sendDecision.gates,
	]
	if (!contact || !state || !email || reviewReasons.length > 0) {
		return {
			contactId: args.intent.contactId,
			fromEmailResourceId,
			nextEmailResourceId,
			nextKitSequenceId,
			status: 'blocked',
			reviewReasons,
			advisoryReasons,
		}
	}
	if (!args.allowWrite) {
		return {
			contactId: contact.id,
			fromEmailResourceId,
			nextEmailResourceId,
			nextKitSequenceId,
			status: 'planned',
			reviewReasons: [],
			advisoryReasons,
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
	const eventKey = `contact:${contact.id}:value-path:${nextValuePathSlug}:drip:${fromEmailResourceId}`
	const event = await args.repository.createContactEvent({
		contactId: contact.id,
		providerIdentityId: identity.id,
		provider: 'ai-hero',
		providerEventId: eventKey,
		providerReference: `value-path:${nextValuePathSlug}`,
		eventType: 'value-path.drip-progressed',
		occurredAt: args.now,
		semanticIdempotencyKey: eventKey,
		privacyLevel: 'internal',
		identityEvidence: identity.evidence,
		payloadSummary: {
			summary: `Drip progressed value path ${nextValuePathSlug} from ${fromEmailResourceId} to ${nextEmailResourceId}`,
			keywords: [
				'value-path',
				'drip-progressed',
				nextValuePathSlug,
				fromEmailResourceId ?? 'unknown-email',
				nextEmailResourceId,
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
		type: 'advance-value-path',
		status: 'planned',
		gates,
		reviewReasons: [],
		rationale: [
			`Daily drip progressed value path after ${fromEmailResourceId}.`,
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
			valuePathSlug: nextValuePathSlug,
			emailResourceId: nextEmailResourceId,
			kitSubscriberId: kitSubscriberId ?? null,
			previousEmailResourceId: fromEmailResourceId,
			progression: 'daily-drip',
			kitSequenceId: nextKitSequenceId,
			providerResult: null,
		},
		createdAt: args.now,
	})
	return {
		contactId: contact.id,
		fromEmailResourceId,
		nextEmailResourceId,
		nextKitSequenceId,
		status: 'planned',
		reviewReasons: [],
		advisoryReasons,
		contactEventId: event.id,
		nextActionId: nextAction.id,
		sideEffectIntentId: intent.id,
	}
}

async function findAnswerClickForCompletedEmail(args: {
	repository: ValuePathDripProgressionRepository
	contactId: string
	fromEmailResourceId?: string
	completedAt?: string
}): Promise<AnswerClickVerification<CaptureMarketingRepositoryContactEvent>> {
	if (!args.repository.findContactEventsByType || !args.fromEmailResourceId) {
		return { verdict: 'none' }
	}
	const emailStepId = emailStepIdFromResourceId(args.fromEmailResourceId)
	if (!emailStepId) return { verdict: 'none' }
	const events = await args.repository.findContactEventsByType(
		args.contactId,
		'value-path.answer-selected',
	)
	return verifyAnswerClickForStep({
		events,
		emailStepId,
		completedAt: args.completedAt,
	})
}

async function findDeliverableIntentSinceClick(args: {
	repository: ValuePathDripProgressionRepository
	contactId: string
	clickOccurredAt: string
	excludeIntentId: string
}): Promise<{ supported: boolean; intent?: SideEffectIntent }> {
	if (!args.repository.findValuePathEmailSideEffectIntentsByContact) {
		return { supported: false }
	}
	const intents =
		await args.repository.findValuePathEmailSideEffectIntentsByContact(
			args.contactId,
		)
	const intent = intents.find(
		(candidate) =>
			candidate.id !== args.excludeIntentId &&
			candidate.createdAt >= args.clickOccurredAt &&
			isDeliverableIntentStatus(candidate),
	)
	return { supported: true, intent }
}

function isDeliverableIntentStatus(intent: SideEffectIntent) {
	if (intent.status === 'pending' || isValuePathIntentCompleted(intent)) return true
	return intent.status === 'failed' && intent.metadata.retryable === true
}

function emailStepIdFromResourceId(emailResourceId: string) {
	const parts = emailResourceId.split('.')
	return parts[parts.length - 1]
}

function stringField(value: unknown) {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberField(value: unknown) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function unique(values: string[]) {
	return Array.from(new Set(values))
}
