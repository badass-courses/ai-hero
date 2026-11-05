'use client'

import { useEffect, useLayoutEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'

/**
 * Puts the reader at the top of the page when they move to another lesson.
 *
 * The App Router only scrolls when the new segment's top edge is off screen.
 * Moving on from the bottom of a long lesson (after its quiz, say), the next
 * lesson can mount with just its loading skeleton. The page is briefly short,
 * the browser clamps the scroll, the segment's top looks "in view", and the
 * router skips the scroll. The body then streams in below and the reader is
 * left near the bottom. Whether that happens depends on what was prefetched,
 * which is why it was only sometimes.
 *
 * This layout stays mounted across lesson, /exercise and /solution
 * navigations, so it sees every pathname change. Back and forward keep the
 * browser's restored position, and a `#fragment` keeps its own target.
 */
export function LessonScrollReset() {
	const pathname = usePathname()
	const previous = useRef(pathname)
	const fromHistory = useRef(false)

	useEffect(() => {
		const onPopState = () => {
			fromHistory.current = true
		}
		window.addEventListener('popstate', onPopState)
		return () => window.removeEventListener('popstate', onPopState)
	}, [])

	useLayoutEffect(() => {
		if (previous.current === pathname) return
		previous.current = pathname
		if (fromHistory.current) {
			fromHistory.current = false
			return
		}
		if (window.location.hash) return
		window.scrollTo({
			top: 0,
			left: 0,
			behavior: 'instant' as ScrollBehavior,
		})
	}, [pathname])

	return null
}
