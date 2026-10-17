import { ACTIVE_PURCHASE_STATUSES } from '@/lib/crash-course-purchaser-tag'

import type { CaptureMarketingRepository } from './capture-contact-event'
import { SUBSCRIBE_EVERGREEN_LIST_INTENT_TYPE } from './drovr-evergreen'
import {
	replayNewsletterExitReceipt,
	type NewsletterExitReplayRepository,
} from './newsletter-exit-replay'
import type { NewsletterVeteransSend } from './newsletter-veterans'
import { normalizeContactEvent } from './normalize-contact-event'
import {
	NEWSLETTER_ADMISSION_HELD,
	OLD_NEWSLETTER_ENROLLMENT_REQUESTED,
	OLD_NEWSLETTER_EXIT_CONFIRMED,
	OLD_NEWSLETTER_REFERENCE,
	OLD_NEWSLETTER_SUBSCRIBED,
	readOldSequenceMembership,
} from './old-newsletter-exit'
import type { ContactEventRecord } from './types'

/**
 * Exit proof from a recorded purchase. drovr's evergreen journey stops its
 * pitch on purchase and hands the contact to the shadow newsletter; ai-hero
 * holds that handoff until the contact is out of the old sequence. A buyer
 * with an active Crash Course purchase is accepted as having left, so this
 * producer writes the same exit receipt the operator chain writes, with a
 * distinct proof kind. Only the proof producer changes: admission, replay
 * and the sender gate read the receipt exactly as before.
 *
 * Off unless the admin flag is on; a flag read that throws counts as off.
 * Refunded, disputed or otherwise inactive purchases never prove exit.
 */
export const PURCHASE_HANDOFF_PROOF_KIND = 'purchase-handoff'
const DEFAULT_LIMIT = 50

export type PurchaseHandoffExitRepository = NewsletterExitReplayRepository &
	Pick<CaptureMarketingRepository, 'findContactById' | 'findProviderIdentity'> &
	Required<
		Pick<CaptureMarketingRepository, 'findExitHeldSideEffectIntentsByType'>
	>

export type PurchaseHandoffExitOutcome =
	| 'admitted'
	| 'replayed-existing-receipt'
	| 'no-active-purchase'
	| 'already-proven'
	| 'contact-email-missing'
	| 'identity-unresolved'
	| 'unproven'

export type PurchaseHandoffExitResult =
	| { status: 'disabled' }
	| {
			status: 'ran'
			results: { contactId: string; outcome: PurchaseHandoffExitOutcome }[]
	  }

export async function runPurchaseHandoffExitPass(args: {
	repository: PurchaseHandoffExitRepository
	isEnabled: () => Promise<boolean>
	/** Statuses of the contact's Crash Course purchases, by email. */
	findCrashCoursePurchaseStatuses: (email: string) => Promise<string[]>
	now: string
	limit?: number
	send?: NewsletterVeteransSend
}): Promise<PurchaseHandoffExitResult> {
	let enabled = false
	try {
		enabled = (await args.isEnabled()) === true
	} catch {
		enabled = false
	}
	if (!enabled) return { status: 'disabled' }
	const held = await args.repository.findExitHeldSideEffectIntentsByType(
		SUBSCRIBE_EVERGREEN_LIST_INTENT_TYPE,
		args.limit ?? DEFAULT_LIMIT,
	)
	const contactIds = [
		...new Set(
			held
				.filter((row) => row.metadata.list === 'shadow-newsletter')
				.map((row) => row.contactId),
		),
	]
	const results: { contactId: string; outcome: PurchaseHandoffExitOutcome }[] =
		[]
	for (const contactId of contactIds) {
		results.push({ contactId, outcome: await produceOne(contactId, args) })
	}
	return { status: 'ran', results }
}

const receiptKey = (contactId: string) =>
	`sequence:2625552:purchase-handoff:${contactId}`

async function produceOne(
	contactId: string,
	args: Parameters<typeof runPurchaseHandoffExitPass>[0],
): Promise<PurchaseHandoffExitOutcome> {
	const { repository, now } = args
	const replay = (receiptId: string) =>
		replayNewsletterExitReceipt({
			repository,
			contactId,
			receiptId,
			now,
			send: args.send,
		})
	const exits = await repository.findContactEventsByType(
		contactId,
		OLD_NEWSLETTER_EXIT_CONFIRMED,
	)
	const own = exits.find(
		(event) =>
			event.providerEventId === receiptKey(contactId) &&
			event.provider === 'kit' &&
			event.providerReference === OLD_NEWSLETTER_REFERENCE,
	)
	// Our receipt exists but the rows are still held: the wakeup was lost. Replay
	// is idempotent, so finish the job without writing a second receipt.
	if (own) {
		const replayed = await replay(own.id)
		return replayed.status === 'resumed'
			? 'replayed-existing-receipt'
			: 'unproven'
	}
	const membership = await readOldSequenceMembership(repository, contactId)
	if (membership === 'exited' || membership === 'absent') return 'already-proven'
	const contact = await repository.findContactById(contactId)
	if (!contact?.email) return 'contact-email-missing'
	const statuses = await args.findCrashCoursePurchaseStatuses(contact.email)
	if (!statuses.some((status) => (ACTIVE_PURCHASE_STATUSES as readonly string[]).includes(status)))
		return 'no-active-purchase'
	const identity = await resolveKitIdentity(repository, contactId)
	if (!identity) return 'identity-unresolved'
	const normalized = normalizeContactEvent({
		provider: 'kit',
		externalId: identity.externalId,
		email: contact.email,
		providerEventId: receiptKey(contactId),
		eventType: OLD_NEWSLETTER_EXIT_CONFIRMED,
		occurredAt: now,
		message: 'Old newsletter exit accepted from drovr purchase handoff',
		privacyLevel: 'internal',
	})
	const receipt = await repository.createContactEvent({
		...normalized,
		contactId,
		providerIdentityId: identity.id,
		providerReference: OLD_NEWSLETTER_REFERENCE,
		createdAt: now,
		payloadSummary: {
			...normalized.payloadSummary,
			summary: JSON.stringify({
				operation: 'purchase-handoff-exit',
				proofKind: PURCHASE_HANDOFF_PROOF_KIND,
			}),
		},
	})
	if (
		receipt.contactId !== contactId ||
		receipt.eventType !== OLD_NEWSLETTER_EXIT_CONFIRMED
	)
		return 'unproven'
	const replayed = await replay(receipt.id)
	return replayed.status === 'resumed' ? 'admitted' : 'unproven'
}

/** The contact's Kit identity, from the hold or the old-sequence history. */
async function resolveKitIdentity(
	repository: PurchaseHandoffExitRepository,
	contactId: string,
): Promise<{ id: string; externalId: string } | undefined> {
	const rows: ContactEventRecord[] = []
	for (const type of [
		NEWSLETTER_ADMISSION_HELD,
		OLD_NEWSLETTER_SUBSCRIBED,
		OLD_NEWSLETTER_ENROLLMENT_REQUESTED,
	])
		rows.push(...(await repository.findContactEventsByType(contactId, type)))
	for (const row of rows) {
		const externalId = row.identityEvidence.providerIdentity?.externalId
		if (row.contactId !== contactId || !externalId) continue
		const identity = await repository.findProviderIdentity('kit', externalId)
		if (identity && identity.contactId === contactId)
			return { id: identity.id, externalId }
	}
	return undefined
}
