import { NonRetriableError } from 'inngest'

/** Measured ceiling: drovr report, observed 2026-10-15.
 * One smooth grid, reserved shares 60/20/15/5 per minute; no borrowing.
 */
export const BULK_EVENTS_PER_MINUTE = 100
export const BULK_EVENT_INTERVAL_MS = Math.ceil(60_000 / BULK_EVENTS_PER_MINUTE)
export const BULK_CLASS_SLOTS = {
	delta: 12,
	restate: 4,
	ingest: 3,
	backfill: 1,
} as const
export const BULK_RESTATE_EVENTS_PER_MINUTE =
	(BULK_EVENTS_PER_MINUTE * BULK_CLASS_SLOTS.restate) /
	Object.values(BULK_CLASS_SLOTS).reduce<number>(
		(sum, weight) => sum + weight,
		0,
	)
export const PROFILE_RESTATEMENT_DAYS = 30
// Keep the previous 4/9 utilization of the restater's reserved bandwidth:
// floor(20 * 15 * 4/9) = 133/tick; 133 * 30 * 24 * 4 = 383,040 contacts.
// Its wire ceiling is 20 * 60 * 24 * 30 = 864,000 one-event confirmations.
// Remaining bandwidth is retry/catch-up headroom, not borrowed live capacity.
export const RESTATEMENT_CONTACTS_PER_TICK = Math.min(
	400,
	Math.floor((BULK_RESTATE_EVENTS_PER_MINUTE * 15 * 4) / 9),
)

export function profileVersionBump(event: {
	kind: 'coupon-issued' | 'profile-change' | 'restate'
	previousHash?: string
	nextHash: string
}): boolean {
	return (
		event.kind === 'profile-change' && event.previousHash !== event.nextHash
	)
}
export function restatementPlan(population: number, now: number) {
	const contacts = Math.max(
		1,
		Math.ceil(population / (PROFILE_RESTATEMENT_DAYS * 24 * 4)),
	)
	if (contacts > RESTATEMENT_CONTACTS_PER_TICK)
		throw new NonRetriableError(
			`RestatementCapacity: you scheduled profile confirmations, and it failed because the monthly quota exceeds the paced share or step budget. Accepted: at most ${RESTATEMENT_CONTACTS_PER_TICK} contacts per tick. Fix: review capacity and the paced lane before increasing the quota. Debug: compare the population with the monthly tick budget.`,
		)
	const monthStart = Date.parse(
		new Date(now).toISOString().slice(0, 7) + '-01T00:00:00.000Z',
	)
	return {
		contacts,
		before: Math.min(now - PROFILE_RESTATEMENT_DAYS * 86400000, monthStart - 1),
	}
}
export type BackfillApproval = {
	canary?: boolean
	dryRunCount?: number
	canaryConfirmed?: boolean
	cursor?: unknown
	approvalToken?: string
}
/** Shape checks are not authorization: the caller must also consume the
 * persisted single-use count/cursor binding from the preceding receipt.
 */
export function requireBackfillCanary(input: BackfillApproval): void {
	if (
		input.canary !== true ||
		!Number.isSafeInteger(input.dryRunCount) ||
		input.dryRunCount! < 0 ||
		(input.cursor !== undefined &&
			(input.canaryConfirmed !== true || !input.approvalToken))
	)
		throw new NonRetriableError(
			'BackfillCanary: you requested a full sync, and it failed because the dry run, approval token or canary confirmation is missing. Accepted: dryRun first, then canary=true with the matching count, then cursor with canaryConfirmed=true and its bound approvalToken. Fix: count without publishing, apply one contact, inspect it, and approve the next manual slice. Debug: inspect the prior receipt.',
		)
}
