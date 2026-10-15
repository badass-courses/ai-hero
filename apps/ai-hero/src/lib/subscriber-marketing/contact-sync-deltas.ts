/** One conservative cap for all bulk sends, including retries and replay.
 * One event every ceil(60_000 / 300) = 200 ms: at most 300 starts in
 * any half-open sliding minute, never a batch burst. drovr will supply a
 * measured number; do not raise this until that measurement is approved.
 */
export const BULK_EVENTS_PER_MINUTE = 300
export const BULK_EVENT_INTERVAL_MS = Math.ceil(60_000 / BULK_EVENTS_PER_MINUTE)
export const PROFILE_RESTATEMENT_DAYS = 30
export const LINK_SEND_MARGIN_MS = 30 * 86400000

export function syncDeliveryLane(reason: string): 'live' | 'bulk' {
	return reason === 'offer-issued' || reason === 'coupon.issued'
		? 'live'
		: 'bulk'
}

export type LinkState = {
	value: string
	profileVersion: number
	expiresAt: number
	dueAt?: number
}
export function linkSendDecision(
	prev: LinkState | undefined,
	next: LinkState,
	now: number,
): { action: 'send' } | { action: 'skip'; reason: 'unchanged' } {
	if (
		!prev ||
		prev.profileVersion !== next.profileVersion ||
		prev.value !== next.value ||
		prev.expiresAt !== next.expiresAt ||
		prev.expiresAt <= Math.max(now, next.dueAt ?? now) + LINK_SEND_MARGIN_MS
	)
		return { action: 'send' }
	return { action: 'skip', reason: 'unchanged' }
}

export function profileVersionBump(event: {
	kind: 'coupon-issued' | 'profile-change' | 'restate'
	previousHash?: string
	nextHash: string
}): boolean {
	return (
		event.kind === 'profile-change' && event.previousHash !== event.nextHash
	)
}

export function bulkPaceDecision(
	nextAt: number,
	now: number,
): { action: 'send'; nextAt: number } | { action: 'wait'; waitMs: number } {
	return now < nextAt
		? { action: 'wait', waitMs: nextAt - now }
		: { action: 'send', nextAt: now + BULK_EVENT_INTERVAL_MS }
}

/** A quota per quarter-hour covers the whole population in a month, with
 * another month of freshness headroom. Never acknowledge a window twice.
 * Capacity failure is explicit, not a silently lengthening rotation.
 */
export function restatementPlan(
	population: number,
	now: number,
): { contacts: number; before: number } {
	const contacts = Math.max(
		1,
		Math.ceil(population / (PROFILE_RESTATEMENT_DAYS * 24 * 4)),
	)
	if (contacts > 400)
		throw new Error(
			'RestatementCapacity: you scheduled profile confirmations, and it failed because the monthly quota exceeds the step budget. Accepted: at most 400 contacts per tick. Fix: review capacity and the paced lane before increasing the quota. Debug: compare the population with the monthly tick budget.',
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
}
export function requireBackfillCanary(input: BackfillApproval): void {
	if (
		input.canary !== true ||
		!Number.isSafeInteger(input.dryRunCount) ||
		input.dryRunCount! < 0 ||
		(input.cursor !== undefined && input.canaryConfirmed !== true)
	)
		throw new Error(
			'BackfillCanary: you requested a full sync, and it failed because the dry run or canary approval is missing. Accepted: dryRun first, then canary=true with dryRunCount, then cursor with canaryConfirmed=true. Fix: count without writes, apply one contact, inspect it, and approve the next manual slice. Debug: inspect the prior run receipt.',
		)
}
