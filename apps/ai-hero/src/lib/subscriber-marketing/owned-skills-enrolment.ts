import { emailEquivalenceKey } from './contact-email-equivalence'
import type { OwnedSkillsNewsletterSubscribed } from '@/inngest/events/skills-newsletter'
import {
	captureNormalizedContactEvent,
	type CaptureMarketingRepository,
} from './capture-contact-event'
import { isContactStopped, readActiveContactStops } from './contact-stop-rule'
import { normalizeContactEvent } from './normalize-contact-event'
import {
	isDrovrOwnedIntent,
	isHeldSignup,
	recordJourneyOwnerAssigned,
	resolveJourneyOwner,
	type DrovrOwnershipConfig,
} from './drovr-ownership'
import {
	dispatchDrovrShadowFactSafely,
	dispatchDrovrShadowFactAwaited,
} from './drovr-shadow-dispatch'
import { requestContactProfileSync } from './drovr-contact-profile-sync-requests'
import {
	EMAIL_COURSE_ENTRY_PAYLOAD_FORMAT,
	restoreEmailCourseEntryPayload,
} from './course-sequence-exhaustion'

export async function resolveOwnedSkillsContact(args: {
	repository: CaptureMarketingRepository
	findContactIdsByEmailKey: (emailKey: string) => Promise<string[]>
	email: string
	name?: string
	userId?: string
	now: string
}) {
	const key = emailEquivalenceKey(args.email)
	const existing = await args.findContactIdsByEmailKey(key)
	if (existing.length > 1)
		throw new Error('Owned enrolment directory ambiguous')
	if (existing[0]) return existing[0]
	const capture = await captureNormalizedContactEvent({
		repository: args.repository,
		now: args.now,
		event: normalizeContactEvent({
			provider: 'ai-hero',
			externalId: `skills-email:${key}`,
			providerEventId: `skills-enrolment-request:${key}`,
			eventType: 'skills-course.enrolment-requested',
			email: args.email,
			name: args.name,
			userId: args.userId,
			occurredAt: args.now,
			message: 'Signed-in Skills course enrolment requested',
			privacyLevel: 'internal',
		}),
	})
	return capture.contact.id
}

/** Owned entry only. Never starts the legacy planner or a newsletter journey. */
export async function enterOwnedSkillsSubscriber(args: {
	repository: CaptureMarketingRepository
	input: OwnedSkillsNewsletterSubscribed['data']
	ownership: DrovrOwnershipConfig
	requestProfileSync?: typeof requestContactProfileSync
	dispatchConsent?: typeof dispatchDrovrShadowFactAwaited
}) {
	const { repository, input } = args
	if (input.formId !== 9376133)
		throw new Error('Owned enrolment requires the Skills form')
	const courseEntryPayload = input.deadlineTimeZone
		? restoreEmailCourseEntryPayload({
				format: EMAIL_COURSE_ENTRY_PAYLOAD_FORMAT,
				valuePathId: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-0',
				deadlineTimeZone: input.deadlineTimeZone,
			})
		: undefined
	if (
		input.deadlineTimeZone &&
		(!courseEntryPayload || !repository.createEmailCourseEntryEvent)
	) {
		throw new Error('Owned enrolment course evidence unavailable')
	}
	const row = await repository.findContactById(input.contactId)
	if (
		!row?.email ||
		row.email.trim().toLowerCase() !== input.email.trim().toLowerCase()
	) {
		throw new Error('Owned enrolment contact mismatch')
	}
	if (!repository.findContactEventsByType)
		throw new Error('Owned enrolment stop reader unavailable')
	if (
		isContactStopped(
			await readActiveContactStops(
				{
					findContactEventsByType:
						repository.findContactEventsByType.bind(repository),
				},
				row.id,
			),
		)
	) {
		return {
			status: 'blocked' as const,
			contactId: row.id,
			reason: 'contact-stopped',
		}
	}
	// A directory identity names this contact, not a fabricated Kit subscriber.
	const externalId = `skills-enrolment:${row.id}`
	let identity = await repository.findProviderIdentity('ai-hero', externalId)
	if (!identity) {
		try {
			identity = await repository.createProviderIdentity({
				contactId: row.id,
				provider: 'ai-hero',
				externalId,
				evidence: {
					providerIdentity: { provider: 'ai-hero', externalId },
					source: 'ai-hero',
					strength: 'strong',
				},
				createdAt: input.subscribedAt,
				updatedAt: input.subscribedAt,
			})
		} catch (error) {
			identity = await repository.findProviderIdentity('ai-hero', externalId)
			if (!identity) throw error
		}
	}
	if (identity.contactId !== row.id)
		throw new Error('Owned enrolment identity mismatch')
	const consentEvent = normalizeContactEvent({
		provider: 'ai-hero',
		externalId,
		providerEventId: `skills-form:${input.formId}:contact:${row.id}`,
		eventType: 'skills-newsletter.subscribed',
		occurredAt: input.subscribedAt,
		email: row.email,
		name: input.name,
		userId: input.signedInUserId,
		message: `Signed-in Skills course opt-in from ${input.source} at ${input.page ?? '/skills'}`,
		privacyLevel: 'internal',
		optInAttribution: input.optInAttribution
			? { ...input.optInAttribution, subscribedAt: input.subscribedAt }
			: undefined,
	})
	consentEvent.payloadSummary.summary = `Signed-in Skills opt-in ${JSON.stringify({ source: input.source, page: input.page ?? '/skills' })}`
	const capture = await captureNormalizedContactEvent({
		repository,
		event: consentEvent,
	})
	// The existing contact-directory confirmation fold records the time. It
	// deliberately does not fabricate a DOI/form confirmation or lift a stop.
	await (args.dispatchConsent ?? dispatchDrovrShadowFactAwaited)({
		kind: 'contact-event',
		event: capture.contactEvent,
	})
	// Existing owners win. This flag is not permission to restart or migrate
	// an in-flight legacy drip; the rollout decision still owns new admissions.
	if (!repository.findValuePathEmailSideEffectIntentsByContact)
		throw new Error('Owned enrolment legacy reader unavailable')
	const intents = await repository.findValuePathEmailSideEffectIntentsByContact(
		row.id,
	)
	if (isHeldSignup(args.ownership, row.email))
		return { status: 'blocked' as const, contactId: row.id, reason: 'held' }
	const owner = await resolveJourneyOwner({
		repository,
		contactId: row.id,
		email: row.email,
		config: args.ownership,
		alreadyEntered: intents.some((intent) => !isDrovrOwnedIntent(intent)),
	})
	if (owner.owner !== 'drovr') {
		return {
			status: 'blocked' as const,
			contactId: row.id,
			reason: 'legacy-owner',
		}
	}
	if (owner.recorded) {
		dispatchDrovrShadowFactSafely({
			kind: 'contact-event',
			event: owner.assignment,
		})
	} else {
		await recordJourneyOwnerAssigned({
			repository,
			contactId: row.id,
			providerIdentityId: identity.id,
			provider: 'ai-hero',
			providerExternalId: externalId,
			email: row.email,
			name: input.name,
			occurredAt: input.subscribedAt,
		})
	}
	// The owned access fact is written only AFTER ownership. No unowned
	// value-path entry and no legacy email/sequence intent can escape here.
	const accessEvent = {
		...normalizeContactEvent({
			provider: 'ai-hero',
			externalId,
			providerEventId: `skills-entry:${row.id}`,
			eventType: 'value-path.entered',
			occurredAt: input.subscribedAt,
			email: row.email,
			name: input.name,
			message: 'Skills course entered with drovr ownership',
			privacyLevel: 'internal',
		}),
		eventType: 'value-path.entered' as const,
		providerReference: 'value-path:ai-hero-skills-workflow',
		contactId: row.id,
		providerIdentityId: identity.id,
		createdAt: input.subscribedAt,
	}
	if (courseEntryPayload && repository.createEmailCourseEntryEvent) {
		await repository.createEmailCourseEntryEvent({
			...accessEvent,
			payloadFormat: EMAIL_COURSE_ENTRY_PAYLOAD_FORMAT,
			domainPayload: courseEntryPayload,
		})
	} else {
		await repository.createContactEvent(accessEvent)
	}
	await (args.requestProfileSync ?? requestContactProfileSync)({
		contactId: row.id,
		reason: 'journey-entered',
		valuePathSlug: 'ai-hero-skills-workflow',
	})
	return {
		status: 'drovr-owned' as const,
		contactId: row.id,
		captureEventId: capture.contactEvent.id,
	}
}
