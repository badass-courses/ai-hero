import type { NewsletterVeteran } from '@/inngest/events/newsletter-veterans'

import type { CaptureMarketingRepository } from './capture-contact-event'
import { findJourneyOwnerAssignment } from './drovr-ownership'
import { DROVR_SHADOW_NEWSLETTER_JOURNEY_ID } from './drovr-shadow-emitter'
import { ensureShadowNewsletterOwnershipAssignment } from './skills-newsletter-path-entry'

/**
 * Small on purpose: every assignment is one contact event whose dispatch
 * lands in the `contact-event` delivery lane that live signups share, so
 * the operator paces batches to what that lane drains.
 */
export const NEWSLETTER_VETERANS_BATCH_SIZE = 50 as const

type NewsletterVeteransMode = 'dry-run' | 'write'

export type NewsletterVeteransCounts = {
	processed: number
	assigned: number
	wouldAssign: number
	alreadyAssigned: number
	missingContact: number
	identityMismatch: number
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

/**
 * Gives contacts that drovr already owns for the course the newsletter
 * ownership assignment they would have received at signup had the gate
 * existed. The assignment is a contact event; the repository dispatches it
 * to drovr, and the emitter turns it into the newsletter actor's birth in
 * the authority tenant. Nothing here touches Kit: moving the contact off
 * Kit's weekly sequence is a separate tag write once the actor exists.
 */
export async function assignNewsletterVeteransBatch(args: {
	repository: NewsletterVeteransRepository
	batch: readonly NewsletterVeteran[]
	dryRun?: boolean
	now?: string
}): Promise<NewsletterVeteransResult> {
	if (args.batch.length > NEWSLETTER_VETERANS_BATCH_SIZE) {
		throw new Error(
			`Newsletter veteran batches cannot exceed ${NEWSLETTER_VETERANS_BATCH_SIZE}`,
		)
	}
	const dryRun = args.dryRun ?? true
	const now = args.now ?? new Date().toISOString()
	const counts: NewsletterVeteransCounts = {
		processed: 0,
		assigned: 0,
		wouldAssign: 0,
		alreadyAssigned: 0,
		missingContact: 0,
		identityMismatch: 0,
	}

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
		const existing = await findJourneyOwnerAssignment(
			args.repository,
			veteran.contactId,
			DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
		)
		if (existing) {
			counts.alreadyAssigned += 1
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
	}

	return { mode: dryRun ? 'dry-run' : 'write', counts }
}
