'use client'

import * as React from 'react'

export function getActivationDelayMs(
	startsAt: string,
	nowMs: number = Date.now(),
): number | null {
	const startsAtMs = Date.parse(startsAt)
	if (!Number.isFinite(startsAtMs)) return null
	return Math.max(0, startsAtMs - nowMs)
}

export function useTimedActivation(
	startsAt: string | undefined,
	initiallyActive: boolean,
) {
	const [active, setActive] = React.useState(initiallyActive)

	React.useEffect(() => {
		if (active || !startsAt) return

		const waitMs = getActivationDelayMs(startsAt)
		if (waitMs === null) return
		if (waitMs === 0) {
			setActive(true)
			return
		}

		const timeout = window.setTimeout(() => setActive(true), waitMs)
		return () => window.clearTimeout(timeout)
	}, [active, startsAt])

	return active
}

export function TimedPromoBarSwitch({
	startsAt,
	initialFeaturedActive,
	featured,
	fallback,
}: {
	startsAt: string
	initialFeaturedActive: boolean
	featured: React.ReactNode
	fallback: React.ReactNode
}) {
	const featuredActive = useTimedActivation(startsAt, initialFeaturedActive)
	return featuredActive ? featured : fallback
}
