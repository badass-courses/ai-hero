'use client'

import * as React from 'react'

/** The half-open window `[startsAt, endsAt)` a promo is live for. */
export type PromoWindow = { startsAt?: string; endsAt?: string }

/** setTimeout stores its delay in a signed 32-bit int; anything larger fires
 *  immediately. A launch scheduled further out than ~24.8 days would otherwise
 *  arm a timer that goes off at once, so long waits are served in chunks. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

export function isWithinPromoWindow(
	{ startsAt, endsAt }: PromoWindow,
	nowMs: number = Date.now(),
): boolean {
	const start = startsAt ? Date.parse(startsAt) : NaN
	const end = endsAt ? Date.parse(endsAt) : NaN
	// An unparseable bound is no bound — same tolerance `getActivationDelayMs`
	// has always had. A typo'd date must not blank the bar.
	if (Number.isFinite(start) && nowMs < start) return false
	if (Number.isFinite(end) && nowMs >= end) return false
	return true
}

/**
 * Milliseconds until the promo's state next changes, or null if it never will.
 *
 * Both bounds count: a live promo with an `endsAt` still has a boundary ahead
 * of it, which is the whole point of the end gate — the tab that was open when
 * the sale ended has to stop advertising it.
 */
export function getActivationDelayMs(
	activeWindow: string | PromoWindow,
	nowMs: number = Date.now(),
): number | null {
	const { startsAt, endsAt }: PromoWindow =
		typeof activeWindow === 'string' ? { startsAt: activeWindow } : activeWindow

	const next = [startsAt, endsAt]
		.map((value) => (value ? Date.parse(value) : NaN))
		.filter((time) => Number.isFinite(time) && time > nowMs)
		.sort((a, b) => a - b)[0]

	if (next === undefined) return null
	return Math.max(0, next - nowMs)
}

/**
 * Tracks whether a promo is inside its live window, flipping in the browser as
 * each boundary passes so a tab opened before the start (or before the end)
 * does not sit on stale copy.
 *
 * Every tick RE-EVALUATES the window rather than latching on. That is what
 * makes the end gate work at all, and it also means a chunked long wait, a
 * clock adjustment, or a tab resumed from sleep lands on the right answer
 * instead of on whatever the last transition happened to be.
 */
export function useTimedActivation(
	activeWindow: string | PromoWindow | undefined,
	initiallyActive: boolean,
) {
	const { startsAt, endsAt } = React.useMemo<PromoWindow>(
		() =>
			typeof activeWindow === 'string'
				? { startsAt: activeWindow }
				: (activeWindow ?? {}),
		[activeWindow],
	)

	const [active, setActive] = React.useState(initiallyActive)

	React.useEffect(() => {
		if (!startsAt && !endsAt) return

		let timeout: number | undefined

		const sync = () => {
			const now = Date.now()
			setActive(isWithinPromoWindow({ startsAt, endsAt }, now))

			const waitMs = getActivationDelayMs({ startsAt, endsAt }, now)
			if (waitMs === null) return

			timeout = window.setTimeout(sync, Math.min(waitMs, MAX_TIMEOUT_MS))
		}

		sync()
		return () => window.clearTimeout(timeout)
	}, [startsAt, endsAt])

	return active
}

export function TimedPromoBarSwitch({
	startsAt,
	endsAt,
	initialFeaturedActive,
	featured,
	fallback,
}: {
	startsAt?: string
	endsAt?: string
	initialFeaturedActive: boolean
	featured: React.ReactNode
	fallback: React.ReactNode
}) {
	const activeWindow = React.useMemo(
		() => ({ startsAt, endsAt }),
		[startsAt, endsAt],
	)
	const featuredActive = useTimedActivation(activeWindow, initialFeaturedActive)
	return featuredActive ? featured : fallback
}
