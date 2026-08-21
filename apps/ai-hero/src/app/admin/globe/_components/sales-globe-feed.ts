import type { SerializedPurchaseTickerHit } from '@/lib/admin-sales-globe-contract'

export const MAX_PENDING_HITS = 40
export const BASE_HIT_GAP_MS = 620
export const TEAM_HIT_GAP_MS = 820
export const MIN_HIT_GAP_MS = 280

/**
 * Space live pings so a burst plays as a kill feed instead of one dump.
 * A deep queue speeds up so the board can catch the present.
 */
export function nextHitGapMs(
	remainingAfterThis: number,
	isTeam: boolean,
): number {
	const base = isTeam ? TEAM_HIT_GAP_MS : BASE_HIT_GAP_MS
	if (remainingAfterThis >= 12) return MIN_HIT_GAP_MS
	if (remainingAfterThis >= 6) return 400
	if (remainingAfterThis >= 3) return Math.min(base, 500)
	return base
}

/**
 * Append unseen hits oldest-first. If the pipe is too long, drop the oldest
 * unplayed so the newest sales still ping.
 */
export function mergePendingHits(
	pending: readonly SerializedPurchaseTickerHit[],
	incoming: readonly SerializedPurchaseTickerHit[],
	maxPending: number = MAX_PENDING_HITS,
): SerializedPurchaseTickerHit[] {
	const ids = new Set(pending.map((hit) => hit.id))
	const next = [...pending]
	for (const hit of incoming) {
		if (ids.has(hit.id)) continue
		ids.add(hit.id)
		next.push(hit)
	}
	if (next.length <= maxPending) return next
	return next.slice(next.length - maxPending)
}
