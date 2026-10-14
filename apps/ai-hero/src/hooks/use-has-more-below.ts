'use client'

import * as React from 'react'

/**
 * Whether the ScrollArea inside `rootRef` has content below its fold, for a
 * bottom fade that says "there is more below". It reads the viewport's own
 * scroll position, so the fade goes at (or within 8px of) the end, and stays
 * off when everything fits. Content that grows and shrinks in place
 * (accordion sections, resolving pricing) is watched as well as the viewport.
 */
export function useHasMoreBelow(
	rootRef: React.RefObject<HTMLElement | null>,
): boolean {
	const [hasMoreBelow, setHasMoreBelow] = React.useState(false)

	React.useEffect(() => {
		const viewport = rootRef.current?.querySelector<HTMLElement>(
			'[data-slot="scroll-area-viewport"]',
		)
		if (!viewport) return

		const update = () => {
			setHasMoreBelow(
				viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 8,
			)
		}
		update()
		viewport.addEventListener('scroll', update, { passive: true })
		const observer = new ResizeObserver(update)
		observer.observe(viewport)
		if (viewport.firstElementChild) observer.observe(viewport.firstElementChild)

		return () => {
			viewport.removeEventListener('scroll', update)
			observer.disconnect()
		}
	}, [rootRef])

	return hasMoreBelow
}
