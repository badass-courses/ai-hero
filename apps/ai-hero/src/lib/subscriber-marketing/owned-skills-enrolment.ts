import type { OwnedSkillsNewsletterSubscribed } from '@/inngest/events/skills-newsletter'
import {
	captureNormalizedContactEvent,
	type CaptureMarketingRepository,
} from './capture-contact-event'
import { isContactStopped, readActiveContactStops } from './contact-stop-rule'
import { normalizeContactEvent } from './normalize-contact-event'
import {
	isDrovrOwnedIntent,
	recordJourneyOwnerAssigned,
	resolveJourneyOwner,
	type DrovrOwnershipConfig,
} from './drovr-ownership'
import { dispatchDrovrShadowFactSafely } from './drovr-shadow-dispatch'
import { requestContactProfileSync } from './drovr-contact-profile-sync-requests'
import {
	EMAIL_COURSE_ENTRY_PAYLOAD_FORMAT,
	restoreEmailCourseEntryPayload,
} from './course-sequence-exhaustion'

export function hasConfirmedSkillsConsent(
	list: {
		state: string
		forms: { formId: string; state: string }[]
		stops: { scope: string; reason: string }[]
	} | null,
) {
	return Boolean(
		list &&
		list.state !== 'stopped' &&
		!list.stops.some((stop) => stop.scope === 'all') &&
		list.forms.some(
			(form) =>
				form.formId === 'skills-newsletter' && form.state === 'confirmed',
		),
	)
}

/** Owned entry only. Never starts the legacy planner or a newsletter journey. */
export async function enterOwnedSkillsSubscriber(args: {
	repository: CaptureMarketingRepository
	input: OwnedSkillsNewsletterSubscribed['data']
	ownership: DrovrOwnershipConfig
	requestProfileSync?: typeof requestContactProfileSync
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
	const capture = await captureNormalizedContactEvent({
		repository,
		event: normalizeContactEvent({
			provider: 'ai-hero',
			externalId,
			providerEventId: `skills-form:${input.formId}:contact:${row.id}`,
			eventType: 'skills-newsletter.subscribed',
			occurredAt: input.subscribedAt,
			email: row.email,
			name: input.name,
			message: `Skills course enrolment from ${input.source}`,
			privacyLevel: 'internal',
			optInAttribution: input.optInAttribution
				? { ...input.optInAttribution, subscribedAt: input.subscribedAt }
				: undefined,
		}),
	})
	// Existing owners win. This flag is not permission to restart or migrate
	// an in-flight legacy drip; the rollout decision still owns new admissions.
	if (!repository.findValuePathEmailSideEffectIntentsByContact)
		throw new Error('Owned enrolment legacy reader unavailable')
	const intents = await repository.findValuePathEmailSideEffectIntentsByContact(
		row.id,
	)
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
