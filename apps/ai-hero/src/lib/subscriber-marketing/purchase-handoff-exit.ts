import { ACTIVE_PURCHASE_STATUSES } from '@/lib/crash-course-purchaser-tag'

import type { CaptureMarketingRepository } from './capture-contact-event'
import { SUBSCRIBE_EVERGREEN_LIST_INTENT_TYPE } from './drovr-evergreen'
import { DROVR_EVERGREEN_OFFER_JOURNEY_ID } from './drovr-shadow-emitter'
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
import type { ContactEventRecord, SideEffectIntent } from './types'

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

export type PurchaseHandoffExitRepository = NewsletterExitReplayRepository &
	Pick<CaptureMarketingRepository, 'findContactById' | 'findProviderIdentity'> &
	Required<
		Pick<CaptureMarketingRepository, 'findExitHeldSideEffectIntentsByType'>
	>

export type PurchaseHandoffExitOutcome =
	| 'admitted'
	| 'replayed-existing-receipt'
	| 'no-active-purchase'
	/** A proof receipt exists from another producer, yet the row is still held. */
	| 'held-despite-proof'
	| 'contact-email-missing'
	| 'identity-unresolved'
	| 'unproven'

export type PurchaseHandoffExitResult =
	| { status: 'disabled' }
	| {
			status: 'ran'
			results: { contactId: string; outcome: PurchaseHandoffExitOutcome }[]
	  }

const PAGE_SIZE = 100
const MAX_PAGES = 100

/** drovr's evergreen journey stamps its handoff rows; the list name alone is
 * not provenance. */
export function isDrovrEvergreenHandoff(row: SideEffectIntent): boolean {
	const drovr = row.metadata.drovr
	return (
		row.type === SUBSCRIBE_EVERGREEN_LIST_INTENT_TYPE &&
		row.metadata.list === 'shadow-newsletter' &&
		row.metadata.source === 'drovr' &&
		typeof drovr === 'object' &&
		drovr !== null &&
		(drovr as { journeyId?: unknown }).journeyId ===
			DROVR_EVERGREEN_OFFER_JOURNEY_ID
	)
}

export async function runPurchaseHandoffExitPass(args: {
	repository: PurchaseHandoffExitRepository
	isEnabled: () => Promise<boolean>
	/** Statuses of Crash Course purchases per lower-cased account email. */
	findCrashCoursePurchaseStatuses: (
		emails: string[],
	) => Promise<Map<string, string[]>>
	now: string
	pageSize?: number
	maxPages?: number
	send?: NewsletterVeteransSend
}): Promise<PurchaseHandoffExitResult> {
	let enabled = false
	try {
		enabled = (await args.isEnabled()) === true
	} catch {
		enabled = false
	}
	if (!enabled) return { status: 'disabled' }
	const results: { contactId: string; outcome: PurchaseHandoffExitOutcome }[] =
		[]
	const seen = new Set<string>()
	let after: { createdAt: string; id: string } | undefined
	// Keyset pages over the whole held set: held non-buyers never hide a buyer.
	for (let page = 0; page < (args.maxPages ?? MAX_PAGES); page++) {
		const rows = await args.repository.findExitHeldSideEffectIntentsByType({
			type: SUBSCRIBE_EVERGREEN_LIST_INTENT_TYPE,
			list: 'shadow-newsletter',
			limit: args.pageSize ?? PAGE_SIZE,
			after,
		})
		if (rows.length === 0) break
		const last = rows[rows.length - 1]!
		after = { createdAt: last.createdAt, id: last.id }
		const contactIds = [
			...new Set(
				rows.filter(isDrovrEvergreenHandoff).map((row) => row.contactId),
			),
		].filter((contactId) => !seen.has(contactId))
		for (const contactId of contactIds) seen.add(contactId)
		results.push(...(await processPage(contactIds, args)))
		if (rows.length < (args.pageSize ?? PAGE_SIZE)) break
	}
	return { status: 'ran', results }
}

const receiptKey = (contactId: string) =>
	`${OLD_NEWSLETTER_REFERENCE}:purchase-handoff:${contactId}`

async function processPage(
	contactIds: string[],
	args: Parameters<typeof runPurchaseHandoffExitPass>[0],
) {
	const { repository, now } = args
	const results: { contactId: string; outcome: PurchaseHandoffExitOutcome }[] =
		[]
	const replay = (contactId: string, receiptId: string) =>
		replayNewsletterExitReceipt({
			repository,
			contactId,
			receiptId,
			now,
			send: args.send,
		})
	const candidates: { contactId: string; email: string }[] = []
	for (const contactId of contactIds) {
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
		// Our receipt exists but the rows are still held: the wakeup was lost.
		// Replay is idempotent, so finish the job without a second receipt.
		if (own) {
			const replayed = await replay(contactId, own.id)
			results.push({
				contactId,
				outcome:
					replayed.status === 'resumed'
						? 'replayed-existing-receipt'
						: 'unproven',
			})
			continue
		}
		const membership = await readOldSequenceMembership(repository, contactId)
		if (membership === 'exited' || membership === 'absent') {
			results.push({ contactId, outcome: 'held-despite-proof' })
			continue
		}
		const contact = await repository.findContactById(contactId)
		if (!contact?.email) {
			results.push({ contactId, outcome: 'contact-email-missing' })
			continue
		}
		candidates.push({ contactId, email: contact.email })
	}
	if (candidates.length === 0) return results
	const statuses = await args.findCrashCoursePurchaseStatuses([
		...new Set(candidates.map((candidate) => candidate.email.toLowerCase())),
	])
	for (const { contactId, email } of candidates) {
		const active = (statuses.get(email.toLowerCase()) ?? []).some((status) =>
			(ACTIVE_PURCHASE_STATUSES as readonly string[]).includes(status),
		)
		if (!active) {
			results.push({ contactId, outcome: 'no-active-purchase' })
			continue
		}
		const identity = await resolveKitIdentity(repository, contactId)
		if (!identity) {
			results.push({ contactId, outcome: 'identity-unresolved' })
			continue
		}
		const normalized = normalizeContactEvent({
			provider: 'kit',
			externalId: identity.externalId,
			email,
			providerEventId: receiptKey(contactId),
			eventType: OLD_NEWSLETTER_EXIT_CONFIRMED,
			occurredAt: now,
			message: 'Old newsletter exit accepted from drovr purchase handoff',
			privacyLevel: 'internal',
		})
		// The semantic key is unique, so a racing writer gets the same row back.
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
		) {
			results.push({ contactId, outcome: 'unproven' })
			continue
		}
		const replayed = await replay(contactId, receipt.id)
		results.push({
			contactId,
			outcome: replayed.status === 'resumed' ? 'admitted' : 'unproven',
		})
	}
	return results
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
