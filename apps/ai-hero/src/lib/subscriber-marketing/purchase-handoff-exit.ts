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
	type OldNewsletterMembership,
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
	/** The contact is recorded as never in the old sequence, yet is held. */
	| 'held-not-in-sequence'
	| 'contact-email-missing'
	| 'identity-unresolved'
	| 'unproven'
	/** This row threw; the rest of the page still ran. */
	| 'error'

export type PurchaseHandoffExitCursor = { createdAt: string; id: string }

export type PurchaseHandoffExitRow = {
	contactId: string
	outcome: PurchaseHandoffExitOutcome
}

export type PurchaseHandoffExitResult =
	| { status: 'disabled' }
	| { status: 'ran'; results: PurchaseHandoffExitRow[] }

export type PurchaseHandoffExitPageResult =
	| { status: 'disabled' }
	| {
			status: 'ran'
			results: PurchaseHandoffExitRow[]
			/** Absent when the held set is exhausted. */
			next?: PurchaseHandoffExitCursor
	  }

export type PurchaseHandoffExitDeps = {
	repository: PurchaseHandoffExitRepository
	isEnabled: () => Promise<boolean>
	/** Statuses of Crash Course purchases per lower-cased account email.
	 * Only purchasers who hold a seat themselves count: an individual
	 * purchase or a redeemed seat, never a bulk purchaser's own bulk row. */
	findCrashCoursePurchaseStatuses: (
		emails: string[],
	) => Promise<Map<string, string[]>>
	now: string
	pageSize?: number
	send?: NewsletterVeteransSend
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

export type PurchaseHandoffExitFacts = {
	email: string | null
	hasActivePurchase: boolean
	/** This hold's own receipt already exists. */
	hasOwnReceipt: boolean
	membership: OldNewsletterMembership
	identityResolved: boolean
}

export type PurchaseHandoffExitDecision =
	| { action: 'skip'; outcome: PurchaseHandoffExitOutcome }
	| { action: 'replay-existing-receipt' }
	| { action: 'write-receipt' }

/**
 * The whole policy, with no reads. Facts after the purchase check may be
 * neutral placeholders when `hasActivePurchase` is false: they are not
 * consulted before that check returns.
 */
export function decidePurchaseHandoffExit(
	facts: PurchaseHandoffExitFacts,
): PurchaseHandoffExitDecision {
	if (!facts.email) return { action: 'skip', outcome: 'contact-email-missing' }
	if (!facts.hasActivePurchase)
		return { action: 'skip', outcome: 'no-active-purchase' }
	// Our receipt exists but the row is still held: the wakeup was lost.
	if (facts.hasOwnReceipt) return { action: 'replay-existing-receipt' }
	const membership = facts.membership
	switch (membership) {
		case 'exited':
			return { action: 'skip', outcome: 'held-despite-proof' }
		case 'absent':
			return { action: 'skip', outcome: 'held-not-in-sequence' }
		case 'present':
		case 'unknown':
			break
		default: {
			const unreachable: never = membership
			throw new Error(`Unhandled membership: ${String(unreachable)}`)
		}
	}
	if (!facts.identityResolved)
		return { action: 'skip', outcome: 'identity-unresolved' }
	return { action: 'write-receipt' }
}

/** One page of the held set. Reads the flag first, so a mid-run switch-off
 * stops the next page. */
export async function runPurchaseHandoffExitPage(
	args: PurchaseHandoffExitDeps & { after?: PurchaseHandoffExitCursor },
): Promise<PurchaseHandoffExitPageResult> {
	let enabled = false
	try {
		enabled = (await args.isEnabled()) === true
	} catch {
		enabled = false
	}
	if (!enabled) return { status: 'disabled' }
	const limit = args.pageSize ?? PAGE_SIZE
	// Keyset pages over the whole held set: held non-buyers never hide a buyer.
	const rows = await args.repository.findExitHeldSideEffectIntentsByType({
		type: SUBSCRIBE_EVERGREEN_LIST_INTENT_TYPE,
		list: 'shadow-newsletter',
		limit,
		after: args.after,
	})
	if (rows.length === 0) return { status: 'ran', results: [] }
	const last = rows[rows.length - 1]!
	const results = await processPage(rows.filter(isDrovrEvergreenHandoff), args)
	return {
		status: 'ran',
		results,
		next:
			rows.length < limit
				? undefined
				: { createdAt: last.createdAt, id: last.id },
	}
}

export async function runPurchaseHandoffExitPass(
	args: PurchaseHandoffExitDeps & { maxPages?: number },
): Promise<PurchaseHandoffExitResult> {
	const results: PurchaseHandoffExitRow[] = []
	let after: PurchaseHandoffExitCursor | undefined
	for (let page = 0; page < (args.maxPages ?? MAX_PAGES); page++) {
		const result = await runPurchaseHandoffExitPage({ ...args, after })
		if (result.status === 'disabled') {
			if (page === 0) return result
			break
		}
		results.push(...result.results)
		if (!result.next) break
		after = result.next
	}
	return { status: 'ran', results }
}

/** One receipt per hold, so a later re-subscribe and re-hold earns its own. */
const receiptKey = (intentId: string) =>
	`${OLD_NEWSLETTER_REFERENCE}:purchase-handoff:${intentId}`

async function processPage(
	rows: SideEffectIntent[],
	args: PurchaseHandoffExitDeps,
): Promise<PurchaseHandoffExitRow[]> {
	const { repository, now } = args
	const results: PurchaseHandoffExitRow[] = []
	const guard = async (
		row: SideEffectIntent,
		work: () => Promise<PurchaseHandoffExitOutcome | undefined>,
	) => {
		try {
			const outcome = await work()
			if (outcome) results.push({ contactId: row.contactId, outcome })
		} catch {
			results.push({ contactId: row.contactId, outcome: 'error' })
		}
	}
	// Cheap first: one contact read per row, then ONE batched purchase lookup.
	const emails = new Map<string, string | null>()
	for (const row of rows)
		await guard(row, async () => {
			const contact = await repository.findContactById(row.contactId)
			emails.set(row.id, contact?.email ?? null)
			return undefined
		})
	const wanted = [
		...new Set(
			[...emails.values()]
				.filter((email): email is string => Boolean(email))
				.map((email) => email.toLowerCase()),
		),
	]
	const statuses =
		wanted.length > 0
			? await args.findCrashCoursePurchaseStatuses(wanted)
			: new Map<string, string[]>()
	for (const row of rows) {
		if (!emails.has(row.id)) continue // its contact read threw; already an error
		const email = emails.get(row.id) ?? null
		const hasActivePurchase =
			email !== null &&
			(statuses.get(email.toLowerCase()) ?? []).some((status) =>
				(ACTIVE_PURCHASE_STATUSES as readonly string[]).includes(status),
			)
		await guard(row, async () => {
			const { contactId } = row
			const replay = (receiptId: string) =>
				replayNewsletterExitReceipt({
					repository,
					contactId,
					receiptId,
					now,
					send: args.send,
				})
			// Per-contact reads happen only for buyers.
			let facts: PurchaseHandoffExitFacts = {
				email,
				hasActivePurchase,
				hasOwnReceipt: false,
				membership: 'unknown',
				identityResolved: false,
			}
			let own: ContactEventRecord | undefined
			let identity: { id: string; externalId: string } | undefined
			if (email && hasActivePurchase) {
				const exits = await repository.findContactEventsByType(
					contactId,
					OLD_NEWSLETTER_EXIT_CONFIRMED,
				)
				own = exits.find(
					(event) =>
						event.providerEventId === receiptKey(row.id) &&
						event.provider === 'kit' &&
						event.providerReference === OLD_NEWSLETTER_REFERENCE,
				)
				identity = await resolveKitIdentity(repository, contactId)
				facts = {
					email,
					hasActivePurchase,
					hasOwnReceipt: Boolean(own),
					membership: await readOldSequenceMembership(repository, contactId),
					identityResolved: Boolean(identity),
				}
			}
			const decision = decidePurchaseHandoffExit(facts)
			if (decision.action === 'skip') return decision.outcome
			if (decision.action === 'replay-existing-receipt') {
				const replayed = await replay(own!.id)
				return replayed.status === 'resumed'
					? 'replayed-existing-receipt'
					: 'unproven'
			}
			const normalized = normalizeContactEvent({
				provider: 'kit',
				externalId: identity!.externalId,
				email: email!,
				providerEventId: receiptKey(row.id),
				eventType: OLD_NEWSLETTER_EXIT_CONFIRMED,
				occurredAt: now,
				message: 'Old newsletter exit accepted from drovr purchase handoff',
				privacyLevel: 'internal',
			})
			// The semantic key is unique, so a racing writer gets the same row back.
			const receipt = await repository.createContactEvent({
				...normalized,
				contactId,
				providerIdentityId: identity!.id,
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
