import {
	DROVR_EVENTS_DELIVER_EVENT,
	type DrovrEventsDeliver,
} from '@/inngest/events/drovr'
import type { NewsletterVeteran } from '@/inngest/events/newsletter-veterans'

import type { CaptureMarketingRepository } from './capture-contact-event'
import { findJourneyOwnerAssignment } from './drovr-ownership'
import {
	DROVR_AUTHORITY_TENANT_ID,
	DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
	DROVR_SKILLS_COURSE_JOURNEY_ID,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'
import { ensureShadowNewsletterOwnershipAssignment } from './skills-newsletter-path-entry'

/**
 * Small on purpose: every batch is one delivery event whose births fold
 * one Durable Object each, and the operator paces batches to what that
 * lane drains.
 */
export const NEWSLETTER_VETERANS_BATCH_SIZE = 50 as const

/** The delivery lane for veteran births, separate from live signups. */
export const NEWSLETTER_VETERANS_SOURCE = 'newsletter-veteran' as const

type NewsletterVeteransMode = 'dry-run' | 'write'

export type NewsletterVeteransCounts = {
	processed: number
	assigned: number
	wouldAssign: number
	alreadyAssigned: number
	/** Births handed to the durable delivery (new and existing assignments). */
	birthsQueued: number
	birthQueueFailed: number
	missingContact: number
	identityMismatch: number
	/** Not drovr-owned for the course, so not a veteran; the cohort row is wrong. */
	notCourseOwned: number
}

export type NewsletterVeteransResult = {
	mode: NewsletterVeteransMode
	counts: NewsletterVeteransCounts
}

export type NewsletterVeteransRepository = Pick<
	CaptureMarketingRepository,
	| 'findContactById'
	| 'findProviderIdentity'
	| 'findContactEventsByType'
	| 'createContactEvent'
>

export type NewsletterVeteransSend = (
	payload: DrovrEventsDeliver,
) => Promise<unknown>

/**
 * The authority-tenant birth for a veteran's newsletter actor. Live signups
 * get theirs from the `skills-newsletter.subscribed` fact (#254); the
 * emitter maps an ownership assignment to a birth only for the course and
 * evergreen journeys, so a veteran's assignment alone births nothing and
 * the birth is sent here explicitly. The key is stable per contact, so a
 * rerun is a no-op fold in drovr.
 */
export function veteranNewsletterBirth(
	contactId: string,
	occurredAt: string,
): DrovrShadowEvent {
	return {
		tenantId: DROVR_AUTHORITY_TENANT_ID,
		contactId,
		journeyId: DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
		type: 'contact.created',
		occurredAt,
		idempotencyKey: `aihero:newsletter-veteran:${contactId}`,
	}
}

const sendThroughInngest: NewsletterVeteransSend = async (payload) => {
	// Lazy: the Inngest client pulls the whole middleware graph at module
	// load, which the unit tests and the operator script must not do.
	const { inngest } = await import('@/inngest/inngest.server')
	return inngest.send(payload)
}

/**
 * Gives contacts that drovr already owns for the course the newsletter
 * ownership assignment they would have received at signup had the gate
 * existed, then hands drovr the newsletter births for the whole batch in
 * one durable delivery. Nothing here touches Kit: moving the contact off
 * Kit's weekly sequence is a separate tag write once the actor exists.
 *
 * Reruns are safe: an existing assignment is kept and its birth is sent
 * again (drovr dedupes on the key), so a batch whose delivery was lost is
 * repaired by running it again.
 */
export async function assignNewsletterVeteransBatch(args: {
	repository: NewsletterVeteransRepository
	batch: readonly NewsletterVeteran[]
	dryRun?: boolean
	now?: string
	send?: NewsletterVeteransSend
}): Promise<NewsletterVeteransResult> {
	if (args.batch.length > NEWSLETTER_VETERANS_BATCH_SIZE) {
		throw new Error(
			`Newsletter veteran batches cannot exceed ${NEWSLETTER_VETERANS_BATCH_SIZE}`,
		)
	}
	const dryRun = args.dryRun ?? true
	const now = args.now ?? new Date().toISOString()
	const send = args.send ?? sendThroughInngest
	const counts: NewsletterVeteransCounts = {
		processed: 0,
		assigned: 0,
		wouldAssign: 0,
		alreadyAssigned: 0,
		birthsQueued: 0,
		birthQueueFailed: 0,
		missingContact: 0,
		identityMismatch: 0,
		notCourseOwned: 0,
	}
	const births: DrovrShadowEvent[] = []

	for (const veteran of args.batch) {
		counts.processed += 1
		const contact = await args.repository.findContactById(veteran.contactId)
		if (!contact?.email) {
			counts.missingContact += 1
			continue
		}
		const identity = await args.repository.findProviderIdentity(
			'kit',
			veteran.kitSubscriberId,
		)
		if (!identity || identity.contactId !== veteran.contactId) {
			counts.identityMismatch += 1
			continue
		}
		const courseOwned = await findJourneyOwnerAssignment(
			args.repository,
			veteran.contactId,
			DROVR_SKILLS_COURSE_JOURNEY_ID,
		)
		if (!courseOwned) {
			counts.notCourseOwned += 1
			continue
		}
		const existing = await findJourneyOwnerAssignment(
			args.repository,
			veteran.contactId,
			DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
		)
		if (existing) {
			counts.alreadyAssigned += 1
			if (!dryRun) births.push(veteranNewsletterBirth(veteran.contactId, now))
			continue
		}
		if (dryRun) {
			counts.wouldAssign += 1
			continue
		}
		await ensureShadowNewsletterOwnershipAssignment({
			repository: args.repository,
			contactId: veteran.contactId,
			providerIdentityId: identity.id,
			kitSubscriberId: veteran.kitSubscriberId,
			email: contact.email,
			name: contact.name ?? undefined,
			occurredAt: now,
		})
		counts.assigned += 1
		births.push(veteranNewsletterBirth(veteran.contactId, now))
	}

	if (births.length > 0) {
		try {
			await send({
				name: DROVR_EVENTS_DELIVER_EVENT,
				data: { events: births, source: NEWSLETTER_VETERANS_SOURCE },
			})
			counts.birthsQueued = births.length
		} catch {
			counts.birthQueueFailed = births.length
		}
	}

	return { mode: dryRun ? 'dry-run' : 'write', counts }
}
