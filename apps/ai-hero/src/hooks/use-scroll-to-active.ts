import { useEffect, useRef } from 'react'

/**
 * Hook to auto-scroll to active resource on mount and when slug changes
 * Maintains scroll position to active lesson when navigating between resources
 */
export function useScrollToActive(currentLessonSlug?: string) {
	const scrollAreaRef = useRef<HTMLDivElement | null>(null)
	const lastSlugRef = useRef<string | undefined>(undefined)
	const hasMountedRef = useRef(false)

	useEffect(() => {
		// On initial mount, always scroll (if slug provided)
		// After that, scroll when slug changes
		const isInitialMount = !hasMountedRef.current
		hasMountedRef.current = true

		// Skip if slug hasn't changed (and not initial mount)
		if (!isInitialMount && currentLessonSlug === lastSlugRef.current) {
			console.debug('[useScrollToActive] Slug unchanged, skipping', {
				current: currentLessonSlug,
				last: lastSlugRef.current,
			})
			return
		}

		console.debug('[useScrollToActive] Slug changed or initial mount', {
			current: currentLessonSlug,
			last: lastSlugRef.current,
			isInitialMount,
		})

		// Skip if no active lesson
		if (!currentLessonSlug) {
			console.debug('[useScrollToActive] No lesson slug provided')
			return
		}

		// Store slug in local variable to track it through async operations
		const slugToScrollTo = currentLessonSlug

		// Mark this slug as processed AFTER scroll completes
		// Don't set it here, or React's double-invoke will skip the scroll

		console.debug('[useScrollToActive] Starting scroll to', slugToScrollTo)

		const scrollAreaRoot = scrollAreaRef.current
		if (!scrollAreaRoot) {
			console.debug('[useScrollToActive] No scrollAreaRoot found')
			return
		}

		// Find the actual scrollable viewport element within ScrollArea
		const scrollAreaViewport = scrollAreaRoot.querySelector(
			'[data-slot="scroll-area-viewport"]',
		) as HTMLElement | null

		if (!scrollAreaViewport) {
			console.debug('[useScrollToActive] No viewport found in scrollAreaRoot', {
				scrollAreaRoot,
				children: Array.from(scrollAreaRoot.children).map((c) => ({
					tag: c.tagName,
					classes: c.className,
					dataSlot: c.getAttribute('data-slot'),
				})),
			})
			return
		}

		console.debug('[useScrollToActive] Found viewport', scrollAreaViewport)

		// Poll until content is ready, then scroll
		let pollTimeoutId: NodeJS.Timeout | null = null
		let retryCount = 0
		const maxRetries = 50 // ~5 seconds max (50 * 100ms)
		const pollInterval = 100 // Check every 100ms

		function attemptScroll() {
			if (!scrollAreaRoot || !scrollAreaViewport) {
				return
			}

			// Scope query to scroll area to avoid conflicts
			const resourceToScrollTo = scrollAreaRoot.querySelector(
				'li[data-active="true"]',
			) as HTMLElement | null

			if (!resourceToScrollTo) {
				if (retryCount < maxRetries) {
					retryCount++
					pollTimeoutId = setTimeout(attemptScroll, pollInterval)
				} else {
					console.debug(
						'[useScrollToActive] No active resource found after max retries',
					)
				}
				return
			}

			// Check if element is actually rendered and has dimensions
			const resourceRect = resourceToScrollTo.getBoundingClientRect()
			if (resourceRect.height === 0) {
				if (retryCount < maxRetries) {
					retryCount++
					pollTimeoutId = setTimeout(attemptScroll, pollInterval)
				}
				return
			}

			// Check if viewport is actually scrollable (content must be taller than viewport)
			const isScrollable =
				scrollAreaViewport.scrollHeight > scrollAreaViewport.clientHeight

			if (!isScrollable) {
				if (retryCount < maxRetries) {
					retryCount++
					pollTimeoutId = setTimeout(attemptScroll, pollInterval)
				} else {
					console.debug(
						'[useScrollToActive] Viewport never became scrollable, content may not need scrolling',
					)
				}
				return
			}

			// Check if the accordion containing this lesson is open
			const parentAccordionContent = resourceToScrollTo.closest(
				'[data-slot="accordion-content"]',
			) as HTMLElement | null
			const isAccordionOpen =
				!parentAccordionContent ||
				parentAccordionContent.getAttribute('data-state') === 'open'

			if (!isAccordionOpen) {
				if (retryCount < maxRetries) {
					retryCount++
					pollTimeoutId = setTimeout(attemptScroll, pollInterval)
				} else {
					console.debug(
						'[useScrollToActive] Accordion never opened, cannot scroll to element',
					)
				}
				return
			}

			// Wait a bit more for accordion animation to fully complete. Only one
			// timer in this chain is ever pending, so `pollTimeoutId` tracks them
			// all and unmount cancels whichever step is in flight.
			pollTimeoutId = setTimeout(() => {
				performScroll()
			}, 150)

			/**
			 * Scroll, then VERIFY with fresh geometry and re-attempt if the element
			 * still isn't visible. The geometry moves under this hook — the section
			 * accordion animates open (scrollHeight grows for ~300ms) and the sticky
			 * sidebar's measured height lands post-hydration — so a target computed
			 * from one snapshot can be stale by the time it's applied. The previous
			 * version scrolled once, clamped to that snapshot's maxScroll, and its
			 * "reset" retries re-asserted the same stale number: on the last lesson
			 * of a section that reliably parked the active row below the fold.
			 */
			function performScroll() {
				if (!scrollAreaViewport || !resourceToScrollTo) {
					return
				}

				const viewportRect = scrollAreaViewport.getBoundingClientRect()
				const resourceRect = resourceToScrollTo.getBoundingClientRect()

				const isElementVisible =
					resourceRect.top >= viewportRect.top &&
					resourceRect.bottom <= viewportRect.bottom

				if (isElementVisible) {
					console.debug(
						'[useScrollToActive] Element already visible, skipping scroll',
					)
					lastSlugRef.current = slugToScrollTo
					return
				}

				// Element's position in the scrollable content, padded from the top
				const offsetFromViewportTop = resourceRect.top - viewportRect.top
				const targetScrollTop = Math.max(
					0,
					scrollAreaViewport.scrollTop + offsetFromViewportTop - 16,
				)
				const maxScroll = Math.max(
					0,
					scrollAreaViewport.scrollHeight - scrollAreaViewport.clientHeight,
				)
				scrollAreaViewport.scrollTop = Math.min(targetScrollTop, maxScroll)

				console.debug('[useScrollToActive] Scrolled', {
					targetScrollTop,
					maxScroll,
					actual: scrollAreaViewport.scrollTop,
					retryCount,
				})

				// Give layout a beat to settle, then re-check for real. Not visible
				// yet (accordion still opening, container resized, Radix reset the
				// scroll) → run the whole attempt again with current geometry.
				pollTimeoutId = setTimeout(() => {
					if (!scrollAreaViewport || !resourceToScrollTo) return
					const vr = scrollAreaViewport.getBoundingClientRect()
					const rr = resourceToScrollTo.getBoundingClientRect()
					const settled = rr.top >= vr.top && rr.bottom <= vr.bottom
					if (!settled && retryCount < maxRetries) {
						retryCount++
						attemptScroll()
						return
					}
					if (!settled) {
						console.debug(
							'[useScrollToActive] Gave up before element became visible',
						)
					}
					lastSlugRef.current = slugToScrollTo
				}, 200)
			}
		}

		// Start polling after DOM is ready
		let rafId2: number | null = null
		const rafId1 = requestAnimationFrame(() => {
			rafId2 = requestAnimationFrame(() => {
				attemptScroll()
			})
		})

		return () => {
			cancelAnimationFrame(rafId1)
			if (rafId2 !== null) {
				cancelAnimationFrame(rafId2)
			}
			if (pollTimeoutId !== null) {
				clearTimeout(pollTimeoutId)
			}
		}
	}, [currentLessonSlug])

	return scrollAreaRef
}
