import type { CaptureMarketingRepository } from './capture-contact-event'
import { normalizeContactEvent } from './normalize-contact-event'
import { ensureShadowNewsletterOwnershipAssignment } from './skills-newsletter-path-entry'
import {
	veteranNewsletterBirth,
	type NewsletterVeteransSend,
} from './newsletter-veterans'
import { DROVR_EVENTS_DELIVER_EVENT } from '@/inngest/events/drovr'
import {
	readOldSequenceMembership,
	OLD_NEWSLETTER_EXIT_CONFIRMED,
	OLD_NEWSLETTER_REFERENCE,
	NEWSLETTER_ADMISSION_HELD,
} from './old-newsletter-exit'

export type NewsletterExitReplayRepository = Pick<
	CaptureMarketingRepository,
	'findContactById' | 'findProviderIdentity' | 'createContactEvent'
> &
	Required<
		Pick<
			CaptureMarketingRepository,
			| 'findContactEventsByType'
			| 'findExitHeldSideEffectIntentsByContact'
			| 'updateSideEffectIntent'
		>
	>

/** held admission -> owned + idempotent birth; held-for-exit send -> pending.
 * Notifications are only wakeups. The persisted, current receipt is the guard. */
export async function replayNewsletterExitReceipt(args: {
	repository: NewsletterExitReplayRepository
	contactId: string
	receiptId: string
	now: string
	send?: NewsletterVeteransSend
}) {
	const exits = await args.repository.findContactEventsByType(
		args.contactId,
		OLD_NEWSLETTER_EXIT_CONFIRMED,
	)
	const receipt = exits.find(
		(event) =>
			event.id === args.receiptId &&
			event.contactId === args.contactId &&
			event.eventType === OLD_NEWSLETTER_EXIT_CONFIRMED &&
			event.provider === 'kit' &&
			event.providerReference === OLD_NEWSLETTER_REFERENCE,
	)
	if (
		!receipt ||
		(await readOldSequenceMembership(args.repository, args.contactId)) !==
			'exited'
	) {
		return { status: 'unproven' as const, admissions: 0, rearmed: 0 }
	}
	const holds = await args.repository.findContactEventsByType(
		args.contactId,
		NEWSLETTER_ADMISSION_HELD,
	)
	const held = holds.find(
		(event) =>
			event.contactId === args.contactId &&
			event.eventType === NEWSLETTER_ADMISSION_HELD,
	)
	let admissions = 0
	const resumed = await args.repository.findContactEventsByType(
		args.contactId,
		'newsletter.admission.resumed',
	)
	const alreadyResumed =
		held &&
		resumed.some(
			(event) =>
				event.contactId === args.contactId &&
				event.providerEventId === `newsletter-admission-resumed:${held.id}`,
		)
	if (held && !alreadyResumed) {
		const contact = await args.repository.findContactById(args.contactId)
		const subscriberId = held.identityEvidence.providerIdentity?.externalId
		if (!contact?.email || !subscriberId)
			throw new Error('Held newsletter admission identity missing')
		const identity = await args.repository.findProviderIdentity(
			'kit',
			subscriberId,
		)
		if (!identity || identity.contactId !== args.contactId)
			throw new Error('Held newsletter admission identity mismatch')
		const assignment = await ensureShadowNewsletterOwnershipAssignment({
			repository: args.repository,
			contactId: args.contactId,
			providerIdentityId: identity.id,
			kitSubscriberId: subscriberId,
			email: contact.email,
			name: contact.name ?? undefined,
			occurredAt: args.now,
		})
		if (assignment.eventType === NEWSLETTER_ADMISSION_HELD)
			return { status: 'unproven' as const, admissions: 0, rearmed: 0 }
		const send =
			args.send ??
			(async (payload) => {
				const { inngest } = await import('@/inngest/inngest.server')
				return inngest.send({
					...payload,
					id: `newsletter-exit-replay:${args.contactId}:${args.receiptId}`,
				})
			})
		await send({
			name: DROVR_EVENTS_DELIVER_EVENT,
			data: {
				events: [veteranNewsletterBirth(args.contactId, args.now)],
				source: 'newsletter-veteran',
			},
		})
		await args.repository.createContactEvent({
			...normalizeContactEvent({
				provider: 'kit',
				externalId: subscriberId,
				email: contact.email,
				providerEventId: `newsletter-admission-resumed:${held.id}`,
				eventType: 'newsletter.admission.resumed',
				occurredAt: args.now,
				message: 'Held newsletter admission resumed from verified exit receipt',
				privacyLevel: 'internal',
			}),
			contactId: args.contactId,
			providerIdentityId: identity.id,
			createdAt: args.now,
		})
		admissions = 1
	}
	const rows = await args.repository.findExitHeldSideEffectIntentsByContact(
		args.contactId,
	)
	for (const row of rows) {
		const { exitHeldAt: _heldAt, lastError: _error, ...metadata } = row.metadata
		await args.repository.updateSideEffectIntent(row.id, {
			status: 'pending',
			completedAt: null,
			gates: row.gates,
			reviewReasons: row.reviewReasons.filter(
				(reason) => reason !== 'old-newsletter-exit-unconfirmed',
			),
			metadata: {
				...metadata,
				exitReceiptId: receipt.id,
				exitRearmedAt: args.now,
			},
		})
	}
	return { status: 'resumed' as const, admissions, rearmed: rows.length }
}
