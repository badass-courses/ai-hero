import { captureNormalizedContactEvent } from './capture-contact-event'
import {
	DROVR_OWNERSHIP_OFF,
	isHeldSignup,
	findJourneyOwnerAssignment,
	recordJourneyOwnerAssigned,
	resolveJourneyOwner,
	type DrovrOwnershipConfig,
} from './drovr-ownership'
import { requestContactProfileSync } from './drovr-contact-profile-sync'
import { dispatchDrovrShadowFactSafely } from './drovr-shadow-dispatch'
import {
	deadlineTimeZoneEvidenceFromHeader,
	restoreDeadlineTimeZoneEvidence,
	type DeadlineTimeZoneEvidence,
} from './course-sequence-exhaustion'
import { normalizeContactEvent } from './normalize-contact-event'
import type { CaptureMarketingRepository } from './capture-contact-event'
import type { ContactState } from './types'
import { isDrovrOwnedIntent } from './drovr-ownership'
import { DROVR_SHADOW_NEWSLETTER_JOURNEY_ID } from './drovr-shadow-emitter'
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
	status: 'planned' | 'blocked' | 'idempotent-noop' | 'drovr-owned' | 'held'
	contactId: string
	captureEventId: string
	entry: ValuePathGateDStartResult
}

export type SkillsNewsletterShadowObserver = (observation: {
	contactId: string
	courseEntryEventId: string
	subscribedAt: string
	deadlineTimeZone?: DeadlineTimeZoneEvidence
}) => Promise<unknown>

/**
 * Mark the legacy newsletter boundary explicitly for a drovr-owned signup.
 * This runs at the exact branch where the Kit probe is skipped, rather than
 * treating skills-course ownership as newsletter ownership. Veterans never
 * get this assignment, so later shadow births cannot migrate them.
 */
export async function ensureShadowNewsletterOwnershipAssignment(args: {
	repository: Pick<
		CaptureMarketingRepository,
		'findContactEventsByType' | 'createContactEvent'
	>
	contactId: string
	providerIdentityId: string
	kitSubscriberId: string
	email: string
	name?: string
	occurredAt: string
}) {
	const existing = await findJourneyOwnerAssignment(
		args.repository,
		args.contactId,
		DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
	)
	if (existing) return existing
	return recordJourneyOwnerAssigned({
		repository: args.repository,
		contactId: args.contactId,
		providerIdentityId: args.providerIdentityId,
		kitSubscriberId: args.kitSubscriberId,
		provider: 'kit',
		providerExternalId: args.kitSubscriberId,
		email: args.email,
		name: args.name,
		occurredAt: args.occurredAt,
		journeyId: DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
	})
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
	shadowObserver?: SkillsNewsletterShadowObserver
	/** Rollout of journey ownership to drovr; absent means nobody. */
	drovrOwnership?: DrovrOwnershipConfig
	/** Defaults to the flag-gated, awaited request (AIH_DROVR_PROFILE_SYNC). */
	requestProfileSync?: typeof requestContactProfileSync
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

	// A held signup is captured (the contact and its id exist) and nothing
	// else: no legacy Email 0, no drovr assignment. Replaying the signup once
	// the address moves to the owner list enters it as drovr-owned: with no
	// legacy send recorded, ownership is still undecided.
	if (isHeldSignup(args.drovrOwnership ?? DROVR_OWNERSHIP_OFF, args.input.email)) {
		return {
			status: 'held',
			contactId: capture.contact.id,
			captureEventId: capture.contactEvent.id,
			entry: emptyEntry(args, capture.contact.id, 'held'),
		}
	}

	// drovr-owned contacts get no legacy Email 0 plan: the ownership event
	// is their birth in drovr's authority tenant, and drovr's actor emits
	// every send from there. Ownership is sticky and never flips a contact
	// the legacy planner already started (a replayed signup stays legacy).
	// "Started" means legacy created a send for the contact. A contact state
	// alone is not that: the capture path writes one (classified or
	// human-review) before any planning, so a contact captured on a path
	// that never ran the entry, confirming later, would otherwise stick to
	// legacy with nothing to continue. Where the repository cannot list a
	// contact's sends, the state row stands in.
	const alreadyEntered =
		capture.idempotentNoop &&
		(await legacyStartedContact(args.repository, capture.contact.id))
	const ownership = await resolveJourneyOwner({
		repository: args.repository,
		contactId: capture.contact.id,
		email: args.input.email,
		alreadyEntered,
		config: args.drovrOwnership ?? DROVR_OWNERSHIP_OFF,
	})
	if (ownership.owner === 'drovr') {
		// A repeat capture computes the contact state but does not write it,
		// so a contact born on a replay would have none, and every send
		// preflight (legacy executor included) refuses contact-state-missing.
		// drovr owns it now: persist what the capture derived.
		if (capture.idempotentNoop) {
			await persistDerivedStateIfAbsent(args.repository, capture.contactState)
		}
		if (ownership.recorded) {
			// A replay is the repair path for a birth whose delivery was lost:
			// drovr dedupes the key, so re-dispatching a landed birth is free.
			dispatchDrovrShadowFactSafely({
				kind: 'contact-event',
				event: ownership.assignment,
			})
		} else {
			await recordJourneyOwnerAssigned({
				repository: args.repository,
				contactId: capture.contact.id,
				providerIdentityId: capture.providerIdentity.id,
				kitSubscriberId: args.input.kitSubscriberId,
				email: args.input.email,
				name: args.input.name,
				occurredAt: args.input.subscribedAt,
			})
		}
		// drovr renders this contact's sends from its synced profile: issue
		// every email of the path now. A replay asks again (drovr keeps the
		// highest profileVersion), and must: its state write above clears the
		// stale-state hold under an old occurredAt, which the contact-sync
		// reconcile's scan does not see. Awaited, and loud if it fails.
		await (args.requestProfileSync ?? requestContactProfileSync)({
			contactId: capture.contact.id,
			reason: 'journey-entered',
			valuePathSlug: SKILLS_WORKFLOW_VALUE_PATH,
		})
		return {
			status: 'drovr-owned',
			contactId: capture.contact.id,
			captureEventId: capture.contactEvent.id,
			entry: emptyEntry(args, capture.contact.id, 'drovr-owned'),
		}
	}

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
	const output = {
		status: result?.status ?? 'blocked',
		contactId: capture.contact.id,
		captureEventId: capture.contactEvent.id,
		entry,
	} satisfies SkillsNewsletterPathEntryResult
	if (
		output.status !== 'blocked' &&
		result?.contactEventId &&
		args.shadowObserver
	) {
		await observeShadowWithoutThrow(args.shadowObserver, {
			contactId: output.contactId,
			courseEntryEventId: result.contactEventId,
			subscribedAt: args.input.subscribedAt,
			...(deadlineTimeZone ? { deadlineTimeZone } : {}),
		})
	}
	return output
}

async function observeShadowWithoutThrow(
	observer: SkillsNewsletterShadowObserver,
	observation: Parameters<SkillsNewsletterShadowObserver>[0],
): Promise<void> {
	try {
		await observer(observation)
	} catch {
		// Shadow state and parity cannot alter the committed production entry.
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
		entry: emptyEntry(args, capture.contact.id, 'blocked', reason),
	}
}

/** A Gate D result that planned nothing: blocked, or owned by drovr. */
function emptyEntry(
	args: {
		allowlist: GateDRuntimeAllowlist
		input: SkillsNewsletterPathEntryInput
		allowWrite: boolean
	},
	contactId: string,
	status: 'blocked' | 'drovr-owned' | 'held',
	reason?: string,
): ValuePathGateDStartResult {
	return {
		mode: args.allowWrite ? 'allow-write' : 'dry-run',
		activationId: args.allowlist.activationId,
		valuePathSlug: SKILLS_WORKFLOW_VALUE_PATH,
		emailResourceId: SKILLS_WORKFLOW_EMAIL_ZERO,
		kitSequenceId: SKILLS_WORKFLOW_EMAIL_ZERO_KIT_SEQUENCE,
		counts: {
			candidates: 1,
			planned: 0,
			blocked: status === 'blocked' ? 1 : 0,
			idempotentNoop: 0,
			wouldCreate: 0,
			created: 0,
		},
		results:
			status === 'blocked'
				? [
						{
							contactId,
							kitSubscriberId: args.input.kitSubscriberId,
							status: 'blocked',
							reviewReasons: reason ? [reason] : [],
						},
					]
				: [],
	}
}

async function legacyStartedContact(
	repository: CaptureMarketingRepository,
	contactId: string,
): Promise<boolean> {
	if (repository.findValuePathEmailSideEffectIntentsByContact) {
		const intents =
			await repository.findValuePathEmailSideEffectIntentsByContact(contactId)
		return intents.some((intent) => !isDrovrOwnedIntent(intent))
	}
	return Boolean(await repository.findCurrentContactState(contactId))
}

/**
 * Insert-if-absent so a concurrent capture's newer state is never replaced
 * by the one this repeat derived. Repositories without the primitive fall
 * back to check-then-write.
 */
async function persistDerivedStateIfAbsent(
	repository: CaptureMarketingRepository,
	state: ContactState,
): Promise<void> {
	if (repository.insertContactStateIfAbsent) {
		await repository.insertContactStateIfAbsent(state)
		return
	}
	if (!(await repository.findCurrentContactState(state.contactId))) {
		await repository.upsertContactState(state)
	}
}
