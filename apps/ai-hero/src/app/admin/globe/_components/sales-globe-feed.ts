import type { SerializedPurchaseTickerHit } from '@/lib/admin-sales-globe-contract'

export const MAX_PENDING_HITS = 40
export const BASE_HIT_GAP_MS = 620
export const TEAM_HIT_GAP_MS = 820
export const MIN_HIT_GAP_MS = 280
export const REPLAY_SPEEDS = [0.5, 1, 2, 4, 8] as const
export const DEFAULT_REPLAY_SPEED = 1
/** Real milliseconds packed into one replay millisecond at 1x. Two minutes of sales become one second. */
export const REPLAY_TIME_SCALE = 120
/** Long enough for the globe look-at to land and sit before the next bing. */
export const REPLAY_MIN_GAP_MS = 1_100
/** Quiet stretches breathe, then move on. Overnight gaps do not stall the board. */
export const REPLAY_MAX_GAP_MS = 3_600
export const REPLAY_LOOK_AT_MIN_MS = 900
export const REPLAY_LOOK_AT_MAX_MS = 2_000

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
 * Map the real gap between two sales onto a globe beat.
 * Clusters stay distinct. Hours of silence compress to a pause, not a stall.
 */
export function replayHitGapMs({
	previousCreatedAt,
	nextCreatedAt,
	speed,
}: {
	previousCreatedAt: string
	nextCreatedAt: string
	speed: number
}): number {
	const safeSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1
	const previous = Date.parse(previousCreatedAt)
	const next = Date.parse(nextCreatedAt)
	const realDelta =
		Number.isFinite(previous) && Number.isFinite(next)
			? Math.max(0, next - previous)
			: 0
	const compressed = realDelta / (REPLAY_TIME_SCALE * safeSpeed)
	return Math.round(
		Math.min(REPLAY_MAX_GAP_MS, Math.max(REPLAY_MIN_GAP_MS, compressed)),
	)
}

/**
 * Camera travel uses most of the beat so the globe turn is the time, not a snap.
 */
export function replayLookAtMs(gapMs: number): number {
	return Math.min(
		REPLAY_LOOK_AT_MAX_MS,
		Math.max(REPLAY_LOOK_AT_MIN_MS, Math.round(gapMs * 0.72)),
	)
}

export function oldestFirst(
	a: SerializedPurchaseTickerHit,
	b: SerializedPurchaseTickerHit,
): number {
	const timeDifference = Date.parse(a.createdAt) - Date.parse(b.createdAt)
	return timeDifference || a.id.localeCompare(b.id)
}
