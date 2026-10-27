import {
	deliverResolvedPurchaseEvents,
	drovrPurchaseRecordedEventsFor,
	normalizeResolveEmail,
	resolveDrovrContacts,
	type DrovrContactResolution,
} from './drovr-purchase-resolve'
import type { PurchaseRecordedSource } from './lifecycle-contact-events'

/**
 * Backfill of purchase.recorded for purchases the ContactEvent mirror skipped.
 * Each buyer is resolved in drovr; only resolved buyers are posted, under the
 * same purchase-id idempotency key as the live path, so a rerun is safe.
 * Counts are the only output: no emails, no ids.
 */

export type BackfillPurchase = PurchaseRecordedSource & { email: string }

export type BackfillCounts = {
	purchases: number
	resolved: number
	missing: number
	conflict: number
	posted: number
	accepted: number
	rejected: number
	/** Rejections by `<HTTP status> <problem type>`; no ids. */
	rejectedBy: Record<string, number>
}

export type SnapshotRow = {
	purchaseId: string
	drovrContactId: string
	productId: string
}

export type BackfillPorts = {
	resolve: (
		emails: readonly string[],
	) => Promise<Map<string, DrovrContactResolution>>
	deliver: typeof deliverResolvedPurchaseEvents
	/** Called once with every resolved row, before the first post. */
	writeSnapshot?: (rows: SnapshotRow[]) => Promise<void>
	sleep: (ms: number) => Promise<void>
}

export const BACKFILL_POST_INTERVAL_MS = 500

export async function runPurchaseBackfill(args: {
	purchases: readonly BackfillPurchase[]
	allowWrite: boolean
	ports: BackfillPorts
	ingestConfig?: { ingestUrl: string; apiKey: string }
	/** Mutated as the run goes, so a failure keeps what was posted. */
	counts?: BackfillCounts
}): Promise<BackfillCounts> {
	const counts: BackfillCounts = args.counts ?? {
		purchases: 0,
		resolved: 0,
		missing: 0,
		conflict: 0,
		posted: 0,
		accepted: 0,
		rejected: 0,
		rejectedBy: {},
	}
	counts.purchases = args.purchases.length
	const answers = await args.ports.resolve(
		args.purchases.map((purchase) => purchase.email),
	)
	const resolved: Array<{ purchase: BackfillPurchase; contactId: string }> = []
	for (const purchase of args.purchases) {
		const answer = answers.get(normalizeResolveEmail(purchase.email))
		if (answer?.status === 'resolved') {
			counts.resolved += 1
			resolved.push({ purchase, contactId: answer.contactId })
		} else if (answer?.status === 'conflict') counts.conflict += 1
		else counts.missing += 1
	}
	if (!args.allowWrite) return counts
	if (!args.ingestConfig) throw new Error('write mode needs the ingest config')
	await args.ports.writeSnapshot?.(
		resolved.map(({ purchase, contactId }) => ({
			purchaseId: purchase.purchaseId,
			drovrContactId: contactId,
			productId: purchase.productId,
		})),
	)
	let first = true
	for (const { purchase, contactId } of resolved) {
		if (!first) await args.ports.sleep(BACKFILL_POST_INTERVAL_MS)
		first = false
		const result = await args.ports.deliver({
			events: drovrPurchaseRecordedEventsFor(purchase, contactId),
			config: args.ingestConfig,
		})
		counts.posted += 1
		counts.accepted += result.accepted
		counts.rejected += result.rejected
		for (const [key, n] of Object.entries(result.rejections ?? {})) {
			counts.rejectedBy[key] = (counts.rejectedBy[key] ?? 0) + n
		}
	}
	return counts
}

export { resolveDrovrContacts }
