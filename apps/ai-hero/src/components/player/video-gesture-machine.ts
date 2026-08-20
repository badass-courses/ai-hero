/**
 * Pure pointer state machine for YouTube-style touch gestures.
 *
 * Owns only the timing/zone logic so it stays unit-testable; the caller
 * translates pointer events into `pointerDown/Move/Up` and reacts to the
 * callbacks. Zones are computed by the caller from the tap's x position.
 *
 * Interaction model (YouTube-style):
 * - single tap        -> resolved after a disambiguation delay; the shell
 *                        maps it to reveal/dismiss chrome (play-state
 *                        agnostic; pre-play it starts playback)
 * - double tap L/R    -> seek -/+ `seekSeconds` (both taps in the same
 *                        zone), then further taps on the same side within
 *                        the accumulate window keep adding
 * - double tap center -> dead zone, treated as a single tap
 * - two taps in
 *   different zones   -> not a double tap; the second restarts as a fresh
 *                        first tap (a sloppy pair must never seek)
 * - press and hold    -> temporary 2x while held
 * - pointer travel    -> cancels the tap/hold (it's a scroll)
 */

export type GestureZone = 'left' | 'center' | 'right'

export type GestureCallbacks = {
	onSingleTap: () => void
	/** deltaSeconds is signed; burstSeconds is the cumulative |amount| for the label */
	onSeek: (deltaSeconds: number, burstSeconds: number, zone: GestureZone) => void
	onHoldStart: () => void
	onHoldEnd: () => void
}

export type GestureOptions = {
	singleTapMs: number
	accumulateMs: number
	holdMs: number
	moveCancelPx: number
	seekSeconds: number
}

export const defaultGestureOptions: GestureOptions = {
	singleTapMs: 250,
	accumulateMs: 650,
	holdMs: 500,
	moveCancelPx: 10,
	seekSeconds: 10,
}

export type GestureMachine = {
	pointerDown: (zone: GestureZone, x: number, y: number) => void
	pointerMove: (x: number, y: number) => void
	pointerUp: () => void
	cancel: () => void
	destroy: () => void
}

/**
 * Creates the touch gesture state machine.
 *
 * @param callbacks - fired as gestures resolve; see {@link GestureCallbacks}
 * @param options - timing/zone overrides merged over {@link defaultGestureOptions}
 */
export function createGestureMachine(
	callbacks: GestureCallbacks,
	options: Partial<GestureOptions> = {},
): GestureMachine {
	const opts = { ...defaultGestureOptions, ...options }

	let singleTapTimer: ReturnType<typeof setTimeout> | null = null
	let accumulateTimer: ReturnType<typeof setTimeout> | null = null
	let holdTimer: ReturnType<typeof setTimeout> | null = null

	let pendingSingle = false
	let pendingZone: GestureZone | null = null
	let accumulateZone: GestureZone | null = null
	let accumulateCount = 0
	let holding = false

	let downZone: GestureZone | null = null
	let downX = 0
	let downY = 0
	let moved = false

	const clearSingle = () => {
		if (singleTapTimer) clearTimeout(singleTapTimer)
		singleTapTimer = null
		pendingSingle = false
		pendingZone = null
	}
	const clearAccumulate = () => {
		if (accumulateTimer) clearTimeout(accumulateTimer)
		accumulateTimer = null
		accumulateZone = null
		accumulateCount = 0
	}
	const clearHold = () => {
		if (holdTimer) clearTimeout(holdTimer)
		holdTimer = null
	}

	const armAccumulate = (zone: GestureZone) => {
		if (accumulateTimer) clearTimeout(accumulateTimer)
		accumulateZone = zone
		accumulateTimer = setTimeout(() => {
			accumulateTimer = null
			accumulateZone = null
			accumulateCount = 0
		}, opts.accumulateMs)
	}

	const seek = (zone: 'left' | 'right') => {
		if (accumulateZone === zone) {
			accumulateCount += 1
		} else {
			accumulateCount = 1
		}
		const direction = zone === 'left' ? -1 : 1
		callbacks.onSeek(
			direction * opts.seekSeconds,
			accumulateCount * opts.seekSeconds,
			zone,
		)
		armAccumulate(zone)
	}

	// Shared by cancel/destroy as a plain closure so a destructured
	// reference works without a bound `this`.
	const cancelAll = () => {
		clearHold()
		clearSingle()
		clearAccumulate()
		downZone = null
		moved = false
		if (holding) {
			holding = false
			callbacks.onHoldEnd()
		}
	}

	return {
		pointerDown(zone, x, y) {
			downZone = zone
			downX = x
			downY = y
			moved = false
			// A press inside the double-tap window suspends the pending chrome
			// toggle; this pointer's outcome decides (tap -> seek, hold -> drop).
			if (pendingSingle && singleTapTimer) {
				clearTimeout(singleTapTimer)
				singleTapTimer = null
			}
			clearHold()
			holdTimer = setTimeout(() => {
				holdTimer = null
				holding = true
				// A hold supersedes any pending tap logic.
				clearSingle()
				clearAccumulate()
				callbacks.onHoldStart()
			}, opts.holdMs)
		},

		pointerMove(x, y) {
			if (downZone === null) return
			if (holding) return
			const dx = x - downX
			const dy = y - downY
			if (dx * dx + dy * dy > opts.moveCancelPx * opts.moveCancelPx) {
				moved = true
				clearHold()
			}
		},

		pointerUp() {
			clearHold()
			if (holding) {
				holding = false
				downZone = null
				callbacks.onHoldEnd()
				return
			}
			const zone = downZone
			downZone = null
			if (zone === null) return
			if (moved) {
				moved = false
				// The finger travelled: it was a scroll, drop any pending toggle too.
				clearSingle()
				return
			}

			// Continuing an accumulate burst: single taps keep seeking. A
			// center tap ends the burst and behaves like a fresh first tap
			// (a swallowed center tap reads as a dead spot).
			if (accumulateZone !== null) {
				if (zone !== 'center') {
					seek(zone)
					return
				}
				clearAccumulate()
			}

			// Second tap of a double tap — only if it lands in the same zone.
			// A cross-zone pair (center-then-right, left-then-right) is sloppy
			// input: drop the pending tap and start over rather than seek.
			if (pendingSingle) {
				const sameZone = zone === pendingZone
				clearSingle()
				if (sameZone) {
					if (zone === 'center') {
						callbacks.onSingleTap()
					} else {
						seek(zone)
					}
					return
				}
			}

			// First tap: wait out the double-tap window before toggling chrome.
			pendingSingle = true
			pendingZone = zone
			singleTapTimer = setTimeout(() => {
				singleTapTimer = null
				pendingSingle = false
				pendingZone = null
				callbacks.onSingleTap()
			}, opts.singleTapMs)
		},

		cancel: cancelAll,
		destroy: cancelAll,
	}
}
