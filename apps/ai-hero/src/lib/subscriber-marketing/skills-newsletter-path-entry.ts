import { captureNormalizedContactEvent } from './capture-contact-event'
import {
	deadlineTimeZoneEvidenceFromHeader,
	restoreDeadlineTimeZoneEvidence,
	type DeadlineTimeZoneEvidence,
} from './course-sequence-exhaustion'
import { normalizeContactEvent } from './normalize-contact-event'
import type { CaptureMarketingRepository } from './capture-contact-event'
import type { OptInAttribution } from './opt-in-attribution'
import type { GateDRuntimeAllowlist } from './value-path-gate-d-allowlist'
import {
	startValuePathGateDActivation,
	type ValuePathGateDStartResult,
} from './value-path-gate-d-start'

export const SKILLS_WORKFLOW_VALUE_PATH = 'ai-hero-skills-workflow' as const
export const SKILLS_WORKFLOW_EMAIL_ZERO =
	'ai-hero-skills-workflow.email-0' as const
export const SKILLS_WORKFLOW_EMAIL_ZERO_KIT_SEQUENCE = '2757199' as const

/**
 * Matt's weekly newsletter, Thursdays 11:00 America/Los_Angeles, 13 emails.
 *
 * Course signups were never landing here: measured 2026-07-30, only 17 of the 500
 * newest form-9376133 subscribers appeared in this sequence, against 429 of 500 for
 * the general form. Course entry and the newsletter are separate destinations, so
 * finishing the course used to mean falling off the list entirely.
 */
export const SHADOW_NEWSLETTER_KIT_SEQUENCE = '2625552' as const
export const SHADOW_NEWSLETTER_BACKFILL_KIT_TAG = '22309615' as const

export type SkillsNewsletterPathEntryInput = {
	kitSubscriberId: string
	email: string
	name?: string
	formId: number
	source: string
	subscribedAt: string
	deadlineTimeZone?: DeadlineTimeZoneEvidence
	optInAttribution?: OptInAttribution
}

export type SkillsNewsletterPathEntryResult = {
	status: 'planned' | 'blocked' | 'idempotent-noop'
	contactId: string
	captureEventId: string
	entry: ValuePathGateDStartResult
}

function attributionWithSubscriptionTime(
	input: SkillsNewsletterPathEntryInput,
) {
	return input.optInAttribution
		? { ...input.optInAttribution, subscribedAt: input.subscribedAt }
		: undefined
}

export async function enterSkillsNewsletterSubscriber(args: {
	repository: CaptureMarketingRepository
	allowlist: GateDRuntimeAllowlist
	input: SkillsNewsletterPathEntryInput
	allowWrite: boolean
	sequenceExhaustionEnabled?: boolean
}): Promise<SkillsNewsletterPathEntryResult> {
	if (args.allowlist.authorizationMode !== 'rolling-public-enrollment') {
		return blockedResult(args, 'rolling-public-enrollment-not-active')
	}

	const capture = await captureNormalizedContactEvent({
		repository: args.repository,
		event: normalizeContactEvent({
			provider: 'kit',
			providerEventId: `skills-form:${args.input.formId}:subscriber:${args.input.kitSubscriberId}`,
			eventType: 'skills-newsletter.subscribed',
			occurredAt: args.input.subscribedAt,
			email: args.input.email,
			name: args.input.name,
			externalId: args.input.kitSubscriberId,
			message: `Skills newsletter subscription from ${args.input.source}`,
			privacyLevel: 'internal',
			optInAttribution: attributionWithSubscriptionTime(args.input),
		}),
	})

	const fallbackDeadline = deadlineTimeZoneEvidenceFromHeader({
		headerValue: undefined,
		capturedAt: args.input.subscribedAt,
		existingLearner:
			args.input.source === 'signup-gap-replay' ||
			args.input.source === 'learner-flow-unstick' ||
			args.input.source === 'kit-confirmation-reconciler',
	})
	const deadlineTimeZone = args.sequenceExhaustionEnabled
		? (restoreDeadlineTimeZoneEvidence(args.input.deadlineTimeZone) ??
			(fallbackDeadline.ok ? fallbackDeadline.value : undefined))
		: undefined

	const entry = await startValuePathGateDActivation({
		repository: args.repository,
		allowlist: {
			...args.allowlist,
			candidates: [
				{
					contactId: capture.contact.id,
					kitSubscriberId: args.input.kitSubscriberId,
					email: args.input.email,
					...(deadlineTimeZone
						? { courseDeadlineTimeZone: deadlineTimeZone }
						: {}),
					rationale: ['Explicit Skills newsletter signup.'],
					blockers: [],
				},
			],
		},
		allowWrite: args.allowWrite,
		valuePathSlug: SKILLS_WORKFLOW_VALUE_PATH,
		emailResourceId: SKILLS_WORKFLOW_EMAIL_ZERO,
		kitSequenceId: SKILLS_WORKFLOW_EMAIL_ZERO_KIT_SEQUENCE,
		now: args.input.subscribedAt,
	})
	const result = entry.results[0]
	return {
		status: result?.status ?? 'blocked',
		contactId: capture.contact.id,
		captureEventId: capture.contactEvent.id,
		entry,
	}
}

async function blockedResult(
	args: {
		repository: CaptureMarketingRepository
		allowlist: GateDRuntimeAllowlist
		input: SkillsNewsletterPathEntryInput
		allowWrite: boolean
	},
	reason: string,
): Promise<SkillsNewsletterPathEntryResult> {
	const capture = await captureNormalizedContactEvent({
		repository: args.repository,
		event: normalizeContactEvent({
			provider: 'kit',
			providerEventId: `skills-form:${args.input.formId}:subscriber:${args.input.kitSubscriberId}`,
			eventType: 'skills-newsletter.subscribed',
			occurredAt: args.input.subscribedAt,
			email: args.input.email,
			name: args.input.name,
			externalId: args.input.kitSubscriberId,
			message: `Skills newsletter subscription from ${args.input.source}`,
			privacyLevel: 'internal',
			optInAttribution: attributionWithSubscriptionTime(args.input),
		}),
	})
	return {
		status: 'blocked',
		contactId: capture.contact.id,
		captureEventId: capture.contactEvent.id,
		entry: {
			mode: args.allowWrite ? 'allow-write' : 'dry-run',
			activationId: args.allowlist.activationId,
			valuePathSlug: SKILLS_WORKFLOW_VALUE_PATH,
			emailResourceId: SKILLS_WORKFLOW_EMAIL_ZERO,
			kitSequenceId: SKILLS_WORKFLOW_EMAIL_ZERO_KIT_SEQUENCE,
			counts: {
				candidates: 1,
				planned: 0,
				blocked: 1,
				idempotentNoop: 0,
				wouldCreate: 0,
				created: 0,
			},
			results: [
				{
					contactId: capture.contact.id,
					kitSubscriberId: args.input.kitSubscriberId,
					status: 'blocked',
					reviewReasons: [reason],
				},
			],
		},
	}
}
