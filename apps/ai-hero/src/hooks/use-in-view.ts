import * as React from 'react'

type UseInViewOptions = {
	/** Fraction of the element that must be visible; `'some'` = any, `'all'` = 100%. */
	amount?: number | 'some' | 'all'
	/** IntersectionObserver `rootMargin`. */
	margin?: string
	/** Stay `true` after the first intersection. */
	once?: boolean
}

/**
 * Is the element in the viewport? Same signature and semantics as
 * framer-motion's `useInView`, which was the only thing two components on
 * every MDX page used the library for — and the reason framer-motion
 * (47KB gz) was in the homepage bundle.
 */
export function useInView(
	ref: React.RefObject<Element | null>,
	{ amount = 'some', margin, once = false }: UseInViewOptions = {},
): boolean {
	const [inView, setInView] = React.useState(false)

	React.useEffect(() => {
		const el = ref.current
		if (!el || typeof IntersectionObserver === 'undefined') return
		const threshold = amount === 'some' ? 0 : amount === 'all' ? 1 : amount
		const observer = new IntersectionObserver(
			([entry]) => {
				const next = entry?.isIntersecting ?? false
				setInView(next)
				if (next && once) observer.disconnect()
			},
			{ rootMargin: margin, threshold },
		)
		observer.observe(el)
		return () => observer.disconnect()
	}, [ref, amount, margin, once])

	return inView
}
