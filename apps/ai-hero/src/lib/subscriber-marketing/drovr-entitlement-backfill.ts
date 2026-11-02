import { drovrEntitlementEventsFor } from '../included-product-entitlement-events'
import {
	deliverResolvedPurchaseEvents,
	normalizeResolveEmail,
	type DrovrContactResolution,
} from './drovr-purchase-resolve'
import type { EntitlementRecordedSource } from './lifecycle-contact-events'

/**
 * Backfill of entitlement.granted and entitlement.revoked for included
 * grants that exist today (included-product-entitlement-events derives the
 * facts from the rows). Each holder is resolved in drovr; only resolved
 * holders are posted, under the live path's idempotency keys, so a rerun
 * changes nothing in drovr. Counts are the only output: no emails, no ids.
 */

export type BackfillEntitlement = EntitlementRecordedSource & { email: string }

export type EntitlementBackfillCounts = {
	facts: number
	granted: number
	revoked: number
	resolved: number
	missing: number
	conflict: number
	posted: number
	accepted: number
	rejected: number
	/** Rejections by `<HTTP status> <problem type>`; no ids. */
	rejectedBy: Record<string, number>
}

export type EntitlementSnapshotRow = {
	entitlementId: string
	change: EntitlementRecordedSource['change']
	drovrContactId: string
}

export type EntitlementBackfillPorts = {
	resolve: (
		emails: readonly string[],
	) => Promise<Map<string, DrovrContactResolution>>
	deliver: typeof deliverResolvedPurchaseEvents
	/** Called once with every resolved row, before the first post. */
	writeSnapshot?: (rows: EntitlementSnapshotRow[]) => Promise<void>
	sleep: (ms: number) => Promise<void>
}

export const ENTITLEMENT_BACKFILL_POST_INTERVAL_MS = 500

export const emptyEntitlementBackfillCounts =
	(): EntitlementBackfillCounts => ({
		facts: 0,
		granted: 0,
		revoked: 0,
		resolved: 0,
		missing: 0,
		conflict: 0,
		posted: 0,
		accepted: 0,
		rejected: 0,
		rejectedBy: {},
	})

export async function runEntitlementBackfill(args: {
	facts: readonly BackfillEntitlement[]
	allowWrite: boolean
	ports: EntitlementBackfillPorts
	ingestConfig?: { ingestUrl: string; apiKey: string }
	/** Mutated as the run goes, so a failure keeps what was posted. */
	counts?: EntitlementBackfillCounts
}): Promise<EntitlementBackfillCounts> {
	const counts = args.counts ?? emptyEntitlementBackfillCounts()
	counts.facts = args.facts.length
	counts.granted = args.facts.filter((fact) => fact.change === 'granted').length
	counts.revoked = counts.facts - counts.granted
	const answers = await args.ports.resolve(args.facts.map((fact) => fact.email))
	const resolved: Array<{ fact: BackfillEntitlement; contactId: string }> = []
	for (const fact of args.facts) {
		const answer = answers.get(normalizeResolveEmail(fact.email))
		if (answer?.status === 'resolved') {
			counts.resolved += 1
			resolved.push({ fact, contactId: answer.contactId })
		} else if (answer?.status === 'conflict') counts.conflict += 1
		else counts.missing += 1
	}
	if (!args.allowWrite) return counts
	if (!args.ingestConfig) throw new Error('write mode needs the ingest config')
	await args.ports.writeSnapshot?.(
		resolved.map(({ fact, contactId }) => ({
			entitlementId: fact.entitlementId,
			change: fact.change,
			drovrContactId: contactId,
		})),
	)
	let first = true
	for (const { fact, contactId } of resolved) {
		if (!first) await args.ports.sleep(ENTITLEMENT_BACKFILL_POST_INTERVAL_MS)
		first = false
		const result = await args.ports.deliver({
			events: await drovrEntitlementEventsFor(fact, contactId),
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
