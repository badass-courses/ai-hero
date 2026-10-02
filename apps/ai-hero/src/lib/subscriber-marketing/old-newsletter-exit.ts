import type { CaptureMarketingRepository } from './capture-contact-event'
import type { ContactEventRecord } from './types'
import { normalizeContactEvent } from './normalize-contact-event'

export const OLD_NEWSLETTER_ENROLLMENT_REQUESTED =
	'newsletter.old-sequence.enrollment-requested'
export const OLD_NEWSLETTER_SUBSCRIBED = 'newsletter.old-sequence.subscribed'
export const OLD_NEWSLETTER_EXIT_CONFIRMED =
	'newsletter.old-sequence.exit-confirmed'
export const OLD_NEWSLETTER_REFERENCE = 'kit:sequence:2625552'
export const OLD_NEWSLETTER_EXIT_TAG = 'shadow-exit-2625552'

export type OldNewsletterReader = { contactId: string; email: string }
export type OldNewsletterMembership = 'present' | 'exited' | 'unknown'
export type OldNewsletterExitGate = (
	reader: OldNewsletterReader,
) => Promise<void>
export type EndOldSequenceMembership = (
	reader: OldNewsletterReader,
) => Promise<'unsupported' | 'requested'>
export type OldNewsletterRepository = Pick<
	CaptureMarketingRepository,
	'findContactEventsByType'
>

export class OldNewsletterExitRefusedError extends Error {
	readonly retryable = true
	constructor(readonly reason: string) {
		super(`old-newsletter-exit-refused:${reason}`)
		this.name = 'OldNewsletterExitRefusedError'
	}
}

/** Only a sequence-specific confirmed-exit receipt is proof. Ownership, absence
 * of historical enrollment records, and an acknowledged exit-tag write are not. */
export async function readOldSequenceMembership(
	repository: OldNewsletterRepository,
	contactId: string,
): Promise<OldNewsletterMembership> {
	if (!repository.findContactEventsByType) return 'unknown'
	const [subscriptions, requests, exits] = await Promise.all([
		repository.findContactEventsByType(contactId, OLD_NEWSLETTER_SUBSCRIBED),
		repository.findContactEventsByType(
			contactId,
			OLD_NEWSLETTER_ENROLLMENT_REQUESTED,
		),
		repository.findContactEventsByType(
			contactId,
			OLD_NEWSLETTER_EXIT_CONFIRMED,
		),
	])
	const latest = (events: ContactEventRecord[], type: string): number =>
		events.reduce((time, event) => {
			if (
				event.contactId !== contactId ||
				event.eventType !== type ||
				event.provider !== 'kit' ||
				event.providerReference !== OLD_NEWSLETTER_REFERENCE
			)
				return time
			const occurredAt = Date.parse(event.occurredAt)
			return Number.isFinite(occurredAt) ? Math.max(time, occurredAt) : time
		}, -Infinity)
	const subscribedAt = Math.max(
		latest(subscriptions, OLD_NEWSLETTER_SUBSCRIBED),
		latest(requests, OLD_NEWSLETTER_ENROLLMENT_REQUESTED),
	)
	const exitedAt = latest(exits, OLD_NEWSLETTER_EXIT_CONFIRMED)
	if (exitedAt > subscribedAt) return 'exited'
	return subscribedAt > -Infinity ? 'present' : 'unknown'
}

/** Record BEFORE a legacy enrollment can run. A failed/ambiguous write is
 * conservatively present too; otherwise an older exit proof could permit sends. */
export async function recordOldNewsletterEnrollmentRequest(args: {
	repository: Pick<
		CaptureMarketingRepository,
		'findProviderIdentity' | 'createContactEvent'
	>
	contactId: string
	kitSubscriberId: string
	email: string
	eventId: string
	now: string
}) {
	const identity = await args.repository.findProviderIdentity(
		'kit',
		args.kitSubscriberId,
	)
	if (!identity || identity.contactId !== args.contactId)
		throw new Error('Old newsletter enrollment identity missing')
	return args.repository.createContactEvent({
		...normalizeContactEvent({
			provider: 'kit',
			externalId: args.kitSubscriberId,
			email: args.email,
			providerEventId: `sequence:2625552:enrollment-requested:${args.eventId}`,
			eventType: OLD_NEWSLETTER_ENROLLMENT_REQUESTED,
			occurredAt: args.now,
			message: 'Old newsletter enrollment requested',
			privacyLevel: 'internal',
		}),
		providerReference: OLD_NEWSLETTER_REFERENCE,
		contactId: args.contactId,
		providerIdentityId: identity.id,
		createdAt: args.now,
	})
}

export function createOldNewsletterExitGate(args: {
	repository: OldNewsletterRepository
	/** Admission only. Send/replay checks never request exits for the held cohort. */
	endOldSequenceMembership?: EndOldSequenceMembership
}): OldNewsletterExitGate {
	return async (reader) => {
		try {
			const membership = await readOldSequenceMembership(
				args.repository,
				reader.contactId,
			)
			if (membership === 'exited') return
			if (args.endOldSequenceMembership) {
				const outcome = await args.endOldSequenceMembership(reader)
				if (outcome === 'unsupported')
					throw new OldNewsletterExitRefusedError('exit-rule-pending')
				// Kit accepted the tag, not the rule's unsubscribe action. Require
				// an independent receipt, including on retries of the tag write.
				if (
					(await readOldSequenceMembership(
						args.repository,
						reader.contactId,
					)) === 'exited'
				)
					return
			}
			throw new OldNewsletterExitRefusedError(`membership-${membership}`)
		} catch (error) {
			if (error instanceof OldNewsletterExitRefusedError) throw error
			throw new OldNewsletterExitRefusedError('membership-or-exit-unavailable')
		}
	}
}

/** The account owner must verify the NEW tag id and approve/configure the UI
 * rule before enabling this adapter. It never creates tags or configures Kit.
 * No membership scans: the rule completion receipt is still required locally. */
export const endOldSequenceMembership: EndOldSequenceMembership = async (
	reader,
) => {
	const tagId = process.env.KIT_SHADOW_NEWSLETTER_EXIT_TAG_ID?.trim()
	if (
		process.env.AIH_SHADOW_NEWSLETTER_EXIT_RULE_READY !== 'true' ||
		!tagId ||
		!/^[1-9]\d*$/.test(tagId) ||
		['23763332', '22309615'].includes(tagId)
	)
		return 'unsupported'
	const { addSubscriberToKitTag } = await import('./drovr-evergreen')
	await addSubscriberToKitTag({
		apiKey: process.env.KIT_V4_API_KEY,
		fetch,
		tagId,
		email: reader.email,
	})
	return 'requested'
}
