import { captureNormalizedContactEvent } from './capture-contact-event'
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

export type SkillsNewsletterPathEntryInput = {
	kitSubscriberId: string
	email: string
	name?: string
	formId: number
	source: string
	subscribedAt: string
	optInAttribution?: OptInAttribution
}

export type SkillsNewsletterPathEntryResult = {
	status: 'planned' | 'blocked' | 'idempotent-noop'
	contactId: string
	captureEventId: string
	entry: ValuePathGateDStartResult
}

function attributionWithSubscriptionTime(input: SkillsNewsletterPathEntryInput) {
	return input.optInAttribution
		? { ...input.optInAttribution, subscribedAt: input.subscribedAt }
		: undefined
}

export async function enterSkillsNewsletterSubscriber(args: {
	repository: CaptureMarketingRepository
	allowlist: GateDRuntimeAllowlist
	input: SkillsNewsletterPathEntryInput
	allowWrite: boolean
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

	const entry = await startValuePathGateDActivation({
		repository: args.repository,
		allowlist: {
			...args.allowlist,
			candidates: [
				{
					contactId: capture.contact.id,
					kitSubscriberId: args.input.kitSubscriberId,
					email: args.input.email,
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
