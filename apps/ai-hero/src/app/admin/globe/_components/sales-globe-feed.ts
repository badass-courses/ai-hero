import type { SerializedPurchaseTickerHit } from '@/lib/admin-sales-globe-contract'

export const MAX_PENDING_HITS = 40
export const BASE_HIT_GAP_MS = 620
export const TEAM_HIT_GAP_MS = 820
export const MIN_HIT_GAP_MS = 280
export const MIN_REPLAY_HIT_GAP_MS = 40
export const REPLAY_SPEEDS = [0.5, 1, 2, 4, 8] as const
export const DEFAULT_REPLAY_SPEED = 2

export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number]

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

/**
 * Replay ignores live catch-up compression. Speed is the only throttle.
 */
export function replayHitGapMs(isTeam: boolean, speed: number): number {
	const base = isTeam ? TEAM_HIT_GAP_MS : BASE_HIT_GAP_MS
	const safeSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1
	return Math.max(MIN_REPLAY_HIT_GAP_MS, Math.round(base / safeSpeed))
}

export function oldestFirst(
	a: SerializedPurchaseTickerHit,
	b: SerializedPurchaseTickerHit,
): number {
	const timeDifference = Date.parse(a.createdAt) - Date.parse(b.createdAt)
	return timeDifference || a.id.localeCompare(b.id)
}
