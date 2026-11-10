'use client'

import * as React from 'react'

/** Less spare width than this and a drawing counts as filling its figure,
    so it stays where its layout puts it. */
const MIN_ROOM = 32

/**
 * A drawing's body, centred under its title by what it draws rather than by
 * the box it is laid out in: a flow whose steps fill eight of twelve
 * columns, or a list as wide as its longest line, would otherwise hug the
 * left. It moves by half the room its ink leaves. The measures are its own,
 * so the move doesn't feed back into them.
 */
export function Centred({ children }: { children: React.ReactNode }) {
	const ref = React.useRef<HTMLDivElement>(null)
	const [shift, setShift] = React.useState(0)

	React.useLayoutEffect(() => {
		const el = ref.current
		if (!el) return
		const measure = () => {
			const extent = inkExtent(el)
			if (!extent) return
			const room = el.clientWidth - (extent.right - extent.left)
			setShift(room > MIN_ROOM ? Math.round(room / 2 - extent.left) : 0)
		}
		measure()
		const resize = new ResizeObserver(measure)
		resize.observe(el)
		// Arrows are drawn after their steps are measured.
		const redraw = new MutationObserver(measure)
		redraw.observe(el, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ['d'],
		})
		return () => {
			resize.disconnect()
			redraw.disconnect()
		}
	}, [])

	// The moved box would stick out past the figure by `shift`, empty but
	// still widening the page, so a moved drawing clips sideways. Its ink sits
	// at least half of MIN_ROOM inside either edge, so nothing drawn is cut.
	return (
		<div className={shift ? '[overflow-x:clip]' : undefined}>
			<div
				ref={ref}
				style={shift ? { transform: `translateX(${shift}px)` } : undefined}
			>
				{children}
			</div>
		</div>
	)
}

/** The left and right edges of everything `el` draws (words, strokes and
    boxes with a border or fill), from its own left edge. */
function inkExtent(el: HTMLElement) {
	const origin = el.getBoundingClientRect().left
	let left = Infinity
	let right = -Infinity
	const take = (rect: DOMRect) => {
		if (rect.width <= 0 || rect.height <= 0) return
		left = Math.min(left, rect.left - origin)
		right = Math.max(right, rect.right - origin)
	}
	const range = document.createRange()
	for (const node of el.querySelectorAll('*')) {
		if (node.closest('.sr-only, defs, marker')) continue
		if (node instanceof SVGGraphicsElement) {
			if (!(node instanceof SVGSVGElement)) take(node.getBoundingClientRect())
			continue
		}
		for (const child of node.childNodes) {
			if (child.nodeType !== Node.TEXT_NODE || !child.textContent?.trim())
				continue
			range.selectNodeContents(child)
			for (const line of range.getClientRects()) take(line)
		}
		const style = getComputedStyle(node)
		if (
			style.borderLeftWidth !== '0px' ||
			style.backgroundColor !== 'rgba(0, 0, 0, 0)'
		)
			take(node.getBoundingClientRect())
	}
	return left < right ? { left, right } : null
}
