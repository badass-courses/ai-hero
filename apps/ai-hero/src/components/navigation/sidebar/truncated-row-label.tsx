'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@coursebuilder/ui/utils/cn'

/** Breathing room on the revealed end. The left end has none, by design. */
const PAD_X = 8
/** How far before the cut the background fades up from transparent. */
const FADE = 28

type Reveal = {
	/** The LABEL's geometry — what the text has to line up with. */
	left: number
	width: number
	lineHeight: number
	/** The ROW's geometry — what the background has to line up with. */
	rowTop: number
	rowHeight: number
	rowRadius: string
	rowBackground: string
	/** Distance from the row's top edge to the label's, so the text stays put. */
	textOffset: number
	font: string
	letterSpacing: string
}

/**
 * A sidebar row's label, which reveals its full text IN PLACE when the rail cut
 * it off.
 *
 * James Chetwood, via Matt (2026-07-31): *"minor UX thing, but it would be nice
 * if the menus showed their full text on hover."* Skill titles are the longest
 * strings in the tree and the rail is 264px, so rows like "grill-with-docs:
 * Align Before…" lose the half that distinguishes them from their neighbours.
 *
 * ## In place, not beside
 *
 * The overlay's text lands exactly on the text it covers and simply keeps
 * going, so the row completes itself rather than answering from a box somewhere
 * else. Its background is a gradient — transparent over the part the row is
 * already drawing, opaque from just before the ellipsis onward. The left half
 * is therefore the row's own label showing through, which is also the only
 * treatment that survives the row changing colour on hover and again when it is
 * the active page; any fixed fill would be wrong in two of those three states.
 *
 * ## Why this is hand-positioned rather than a Radix tooltip
 *
 * It was one, and both of its jobs fought the library. Anchoring an overlay ON
 * its own trigger means a negative `sideOffset`, which the popper's collision
 * handling is entitled to adjust — so the text sat a few pixels off. And
 * hovering the whole ROW rather than the label means driving `open` from
 * outside, while Radix keeps its own hover handlers bound to the trigger, so
 * the two took turns opening and closing it.
 *
 * A fixed-position element at the label's own `getBoundingClientRect()` has
 * neither problem: alignment is exact by construction, and nothing else has an
 * opinion about when it shows. A portal is still required — `SidebarMenuButton`
 * is `overflow-hidden` and the rail is a scroll container, so anything in flow
 * is clipped by the very box that clipped the text.
 *
 * ## Why it measures first
 *
 * The overlay only exists when the text is ACTUALLY cut off. Most rows fit, and
 * repeating a label you can already read is noise on every hover in the tree.
 *
 * The full text is in the DOM either way, so none of this changes what a screen
 * reader gets; truncation was only ever visual.
 */
export function TruncatedRowLabel({
	children,
	className,
}: {
	/** Plain text. Anything richer has no sensible overlay body. */
	children: string
	className?: string
}) {
	const ref = React.useRef<HTMLSpanElement>(null)
	const [reveal, setReveal] = React.useState<Reveal | null>(null)

	React.useEffect(() => {
		const element = ref.current
		// Hovering anywhere on the ROW opens it, not just the text. The label is a
		// span in the middle of a padded link, and the numeral, the icon and the
		// padding either side are most of what a pointer actually crosses.
		const row = element?.closest('a, button')
		if (!element || !row) return

		// No open delay. A tooltip waits because it is an extra thing arriving on
		// top of what you are looking at, and a wait is what stops it firing at
		// every row a pointer crosses. This is not that: it completes the label
		// already under the cursor, in place, so the wait read as the row being
		// slow rather than as restraint. Nothing new appears, so nothing needs to
		// hold back before appearing.
		const open = () => {
			// Measured against the TEXT's own laid-out width, not `scrollWidth`.
			//
			// `scrollWidth` and `clientWidth` are integers, so they cannot see an
			// overflow smaller than a pixel — and the browser draws an ellipsis for
			// any overflow at all. "The /grill-with-docs Skill" lays out at 147.2px
			// in a 147px box: visibly cut, with a whole character replaced by the
			// ellipsis, while both properties report 147 and the old check concluded
			// it fits. A `Range` over the contents reports the sub-pixel width the
			// layout actually used.
			const rect = element.getBoundingClientRect()
			const style = getComputedStyle(element)
			const inner =
				rect.width -
				parseFloat(style.paddingLeft) -
				parseFloat(style.paddingRight)
			const range = document.createRange()
			range.selectNodeContents(element)
			const textWidth = range.getBoundingClientRect().width
			range.detach()
			if (textWidth <= inner + 0.05) return
			// Read at open time, not on mount: the rail collapses, the window
			// resizes, and the row moves whenever the tree above it expands.
			//
			// The ROW is measured too, and its background read AFTER the hover has
			// landed, so the extension continues whatever pill is actually under the
			// pointer — the hover wash, or the heavier fill of the active page.
			const rowRect = row.getBoundingClientRect()
			const rowStyle = getComputedStyle(row)
			setReveal({
				left: rect.left,
				width: rect.width,
				lineHeight: rect.height,
				rowTop: rowRect.top,
				rowHeight: rowRect.height,
				rowRadius: rowStyle.borderRadius,
				rowBackground: rowStyle.backgroundColor,
				textOffset: rect.top - rowRect.top,
				// Portalled to `document.body`, so it inherits nothing from the row
				// and its type has to be carried across. Read rather than hardcoded:
				// rows come in two sizes (`SIDEBAR_ROW_CLASS` and its nested variant).
				font: style.font,
				letterSpacing: style.letterSpacing,
			})
		}

		const hide = () => setReveal(null)

		row.addEventListener('pointerenter', open)
		row.addEventListener('pointerleave', hide)
		// Keyboard parity: the label is not focusable, the row is.
		row.addEventListener('focus', open)
		row.addEventListener('blur', hide)
		// Fixed to the viewport, so anything that moves the row underneath it has
		// to dismiss it rather than let it drift. Capture, because the rail scrolls
		// in its own container rather than on the window.
		window.addEventListener('scroll', hide, true)
		window.addEventListener('resize', hide)

		return () => {
			row.removeEventListener('pointerenter', open)
			row.removeEventListener('pointerleave', hide)
			row.removeEventListener('focus', open)
			row.removeEventListener('blur', hide)
			window.removeEventListener('scroll', hide, true)
			window.removeEventListener('resize', hide)
		}
	}, [children])

	// `flex-1 min-w-0` is load-bearing, not styling. A flex item defaults to
	// `min-width: auto`, so without it the span sizes to its full text and the
	// ROW's `overflow-hidden` does the cutting — the text looks truncated while
	// the span's own `scrollWidth` equals its `clientWidth`, so the check above
	// reports "fits" and no overlay is ever built.
	//
	// `text-left` because a section header's row is a `<button>`, and the UA
	// stylesheet centres a button's text. It never showed while the span hugged
	// its content; the moment `flex-1` let it fill the row, every section label
	// slid to the middle.
	return (
		<>
			<span
				ref={ref}
				className={cn('min-w-0 flex-1 truncate text-left', className)}
			>
				{children}
			</span>
			{reveal ? <RevealOverlay reveal={reveal}>{children}</RevealOverlay> : null}
		</>
	)
}

function RevealOverlay({
	reveal,
	children,
}: {
	reveal: Reveal
	children: string
}) {
	if (typeof document === 'undefined') return null

	return createPortal(
		<span
			aria-hidden
			style={{
				position: 'fixed',
				// Horizontally the box starts `PAD_X` left of the TEXT, so its own
				// padding puts the first glyph exactly where the row's first glyph is.
				//
				// Vertically it takes the ROW's box, not the label's: what continues
				// past the cut has to be the row's pill, at the row's full height, or
				// the extension reads as a thin strip pasted across a taller button.
				// `textOffset` then puts the text back on the line it was on.
				left: reveal.left - PAD_X,
				top: reveal.rowTop,
				height: reveal.rowHeight,
				paddingTop: reveal.textOffset,
				paddingLeft: PAD_X,
				paddingRight: PAD_X,
				// `font` is a SHORTHAND and resets line-height, so it has to come
				// before the explicit line-height rather than after it.
				font: reveal.font,
				lineHeight: `${reveal.lineHeight}px`,
				letterSpacing: reveal.letterSpacing,
				whiteSpace: 'nowrap',
				maxWidth: 'min(360px, 90vw)',
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				// The row's own radius, so the extension ends the way the pill would.
				// Square on the left, where it is still inside the row.
				borderRadius: `0 ${reveal.rowRadius} ${reveal.rowRadius} 0`,
				// A picture of the row, never a target: under the cursor it would take
				// the hover, dropping the link's pointer cursor back to an arrow and
				// pulling the pointer off the row that is keeping it open.
				pointerEvents: 'none',
				zIndex: 60,
				// Two layers, both masked by the same fade so the left end stays
				// transparent and the row shows through. On top, the row's own
				// background — the hover wash or the active fill, whichever is
				// actually there. Underneath, the rail's surface, because that wash is
				// semi-transparent and the part of the extension hanging over the
				// content column needs something opaque behind it.
				backgroundImage: [
					`linear-gradient(to right, transparent ${Math.max(0, reveal.width - FADE) + PAD_X}px, ${reveal.rowBackground} ${reveal.width + PAD_X}px)`,
					`linear-gradient(to right, transparent ${Math.max(0, reveal.width - FADE) + PAD_X}px, var(--sidebar) ${reveal.width + PAD_X}px)`,
				].join(', '),
			}}
			// `font` above carries family, size and line-height; colour is the one
			// thing it does not, and the row's own muted ink would be unreadable on
			// the popover fill the revealed half sits on.
			className="text-foreground"
		>
			{children}
		</span>,
		document.body,
	)
}
