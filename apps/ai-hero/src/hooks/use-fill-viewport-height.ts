import { useEffect, useRef } from 'react'

/**
 * Sizes a sticky sidebar to exactly the viewport space below its current top
 * edge: `100dvh - max(0, rect.top)`.
 *
 * No static height can do this. The chrome above the sidebar (promo bar + nav
 * on lesson pages) scrolls away rather than sticking, so the right height is
 * scroll-dependent: `100vh - 96px` at the top of the page, `100vh` once the
 * sidebar pins at `top: 0`, and every value in between while the chrome is
 * partially visible. The static `calc(100vh - var(--nav-height))` class was
 * tuned for the promo-bar-less top-of-page state — with the bar it hung 34px
 * below the fold (clipping the auto-scrolled last lesson on refresh), and once
 * pinned it left a 62px dead gap at the bottom.
 *
 * The measured inline height overrides that class, which stays on as the
 * SSR/first-paint fallback. Reading `rect.top` and writing `height` doesn't
 * feed back into itself — a sticky element's top depends on scroll position
 * and flow, not its own height.
 */
export function useFillViewportHeight<T extends HTMLElement>(enabled = true) {
	const ref = useRef<T | null>(null)

	useEffect(() => {
		const element = ref.current
		if (!enabled || !element) return

		// One rect read + one style write, straight in the handler. Scroll events
		// already fire at most once per frame, so an rAF wrapper adds nothing but
		// a frame of lag — and in occluded windows Chrome throttles rAF far below
		// the scroll event rate, leaving the height visibly stale.
		const update = () => {
			const top = Math.max(0, element.getBoundingClientRect().top)
			element.style.height = `calc(100dvh - ${top}px)`
		}

		update()
		window.addEventListener('scroll', update, { passive: true })
		window.addEventListener('resize', update)

		// Re-measure on container resize: the collapsed sidebar hides this
		// element entirely (it measures `top: 0` while `display: none`), and
		// re-expanding it doesn't fire a scroll event to fix the stale height.
		// Re-writing the same height doesn't change the box, so this can't loop.
		const observer = new ResizeObserver(update)
		observer.observe(element.parentElement ?? element)

		return () => {
			window.removeEventListener('scroll', update)
			window.removeEventListener('resize', update)
			observer.disconnect()
			element.style.height = ''
		}
	}, [enabled])

	return ref
}
