'use client'

import * as React from 'react'

/**
 * Lock page scrolling while an overlay is open, without the page jumping.
 *
 * `overflow: hidden` on `<body>` alone loses the scroll position on iOS Safari
 * and, on desktop, removes the scrollbar and reflows the layout a few pixels
 * left. So: pin the body at its current offset with `position: fixed` and a
 * negative `top`, then restore both the styles and the scroll position on
 * release. `scrollRestoration` is untouched — this is a within-page lock, not a
 * navigation.
 *
 * Idempotent across concurrent callers is NOT a goal: only one overlay in this
 * app locks at a time, and pretending otherwise would need a lock count that
 * nothing here would ever exercise.
 */
export function useBodyScrollLock(locked: boolean) {
	React.useEffect(() => {
		if (!locked) return

		const { body } = document
		const scrollY = window.scrollY
		// Where we were when the lock went on. If the lock comes off because the
		// reader NAVIGATED — the usual way a nav drawer closes — restoring this
		// offset would scroll a page they have never seen to the previous page's
		// position, dropping them into the middle of it. Compared at release.
		const lockedAtPath = window.location.pathname
		const previous = {
			position: body.style.position,
			top: body.style.top,
			left: body.style.left,
			right: body.style.right,
			overflow: body.style.overflow,
		}

		body.style.position = 'fixed'
		body.style.top = `-${scrollY}px`
		body.style.left = '0'
		body.style.right = '0'
		body.style.overflow = 'hidden'

		return () => {
			body.style.position = previous.position
			body.style.top = previous.top
			body.style.left = previous.left
			body.style.right = previous.right
			body.style.overflow = previous.overflow
			// Only restore when we are still on the page that was pinned. After a
			// navigation the new page owns its own scroll position — Next has
			// already put it at the top — and re-applying the old offset here is
			// what made tapping a drawer link land mid-article.
			if (window.location.pathname === lockedAtPath) {
				// `instant`: an animated scroll here reads as the page sliding away
				// underneath the closing drawer.
				window.scrollTo({ top: scrollY, behavior: 'instant' as ScrollBehavior })
			}
		}
	}, [locked])
}
