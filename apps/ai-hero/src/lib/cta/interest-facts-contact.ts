import {
	captureNormalizedContactEvent,
	type CaptureMarketingRepository,
} from '@/lib/subscriber-marketing/capture-contact-event'
import { emailEquivalenceKey } from '@/lib/subscriber-marketing/contact-email-equivalence'
import { normalizeContactEvent } from '@/lib/subscriber-marketing/normalize-contact-event'

/** ContactEvent.eventType for the contact a cold join is held on. */
export const INTEREST_JOIN_REQUESTED_EVENT_TYPE = 'interest.join-requested'

/**
 * The contact a waitlist or interest join is recorded on, when the join is
 * all the site hears (`AIH_WAITLIST_OFF_KIT_ENABLED`). With no Kit subscribe
 * and no double opt-in behind it, a join from an address the site has never
 * seen would wait out its 7-day window and be lost.
 *
 * A known address mints nothing. An unknown one gets an owned `ai-hero`
 * contact, the same capture path a double opt-in signup takes before it
 * confirms (`resolveDoiSignupContact`). It carries no consent: no
 * confirmation, no form, no list. drovr hears of it only through the
 * existing directory seed, as a provisional contact.
 */
export async function resolveInterestJoinContact(args: {
	repository: CaptureMarketingRepository
	findContactIdsByEmailKey: (emailKey: string) => Promise<string[]>
	email: string
	name?: string
	now: string
}): Promise<{ minted: boolean }> {
	const emailKey = emailEquivalenceKey(args.email)
	if ((await args.findContactIdsByEmailKey(emailKey)).length > 0) {
		return { minted: false }
	}
	const externalId = `interest-email:${emailKey}`
	const capture = await captureNormalizedContactEvent({
		repository: args.repository,
		event: normalizeContactEvent({
			provider: 'ai-hero',
			providerEventId: `interest-join:${externalId}`,
			eventType: INTEREST_JOIN_REQUESTED_EVENT_TYPE,
			occurredAt: args.now,
			email: args.email,
			name: args.name,
			externalId,
			message: 'Waitlist or interest join',
			privacyLevel: 'internal',
		}),
		now: args.now,
	})
	return { minted: !capture.idempotentNoop }
}
