'use client'

import React from 'react'
import { XMarkIcon } from '@heroicons/react/24/outline'
import {
	motion,
	useIsPresent,
	useReducedMotion,
	type Variants,
} from 'framer-motion'

import type { ContentResource } from '@coursebuilder/core/schemas'
import {
	useVideoPlayerOverlay,
	type CompletedAction,
} from '@coursebuilder/ui/hooks/use-video-player-overlay'
import { cn } from '@coursebuilder/ui/utils/cn'

const easeOutQuint = [0.22, 1, 0.36, 1] as const

/**
 * The overlay's COMPLETED action. The ui package's reducer stores the action
 * as given, so the autoplay countdown rides on it rather than adding a state.
 * `resource` is the lesson whose end drew the card: the host swaps lessons
 * under a card it holds up, and the card must keep acting for its own.
 */
export type EndCardAction = CompletedAction & {
	autoAdvance?: boolean
	resource: ContentResource
}

export const AUTO_ADVANCE_SECONDS = 5

// How the learner last interacted. The card focuses its primary button on
// arrival; after a click or tap that focus should not draw the keyboard ring.
let lastInputWasPointer = false
if (typeof window !== 'undefined') {
	window.addEventListener('pointerdown', () => (lastInputWasPointer = true), true)
	window.addEventListener('keydown', () => (lastInputWasPointer = false), true)
}

/** Secondary actions on the card (Replay, certificate beside a next step). */
export const END_CARD_SECONDARY =
	'h-10 rounded-[9px] border border-white/20 bg-white/10 px-4 text-white hover:bg-white/20'

const CONTROL_ROLES = new Set(['button', 'link', 'checkbox', 'switch', 'tab'])

function isControl(node: EventTarget) {
	const el = node as HTMLElement
	if (!el?.localName) return false
	if (['button', 'a', 'input', 'textarea', 'select', 'summary'].includes(el.localName))
		return true
	if (el.isContentEditable) return true
	const role = el.getAttribute?.('role')
	return Boolean(role && CONTROL_ROLES.has(role))
}

/**
 * The shared frame of both end cards: scrim, close button, enter and exit
 * motion, focus and keys. Render it as the direct child of an
 * `AnimatePresence` so the exit fade can run.
 *
 * Mark the primary action with `data-end-card-primary` (on the control or a
 * wrapper around it) and the one that moves on with `data-end-card-continue`.
 *
 * `inert` while the host has already swapped to the next lesson and only
 * holds the card up over it: no pointer, focus or keys until it hides.
 */
export function EndCard({
	inert = false,
	children,
}: {
	inert?: boolean
	children: React.ReactNode
}) {
	const ref = React.useRef<HTMLDivElement>(null)
	const isPresent = useIsPresent()
	const { dispatch } = useVideoPlayerOverlay()

	// Take focus only from nowhere or from the player itself; a learner
	// reading the transcript or typing a note keeps their place.
	React.useEffect(() => {
		const card = ref.current
		if (!card) return
		const active = document.activeElement
		const shell = card.closest('[data-player-gesture-shell]')
		if (active && active !== document.body && !shell?.contains(active)) return
		const primary = card.querySelector<HTMLElement>('[data-end-card-primary]')
		const target = primary?.matches('a, button')
			? primary
			: primary?.querySelector<HTMLElement>('a, button')
		// `focusVisible` is not in TypeScript's DOM types yet.
		target?.focus({
			preventScroll: true,
			focusVisible: !lastInputWasPointer,
		} as FocusOptions)
	}, [])

	React.useEffect(() => {
		if (!isPresent || inert) return
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.defaultPrevented || e.isComposing) return
			if (e.ctrlKey || e.metaKey || e.altKey) return
			const card = ref.current
			const shell = card?.closest('[data-player-gesture-shell]')
			const path = e.composedPath()
			const target = path[0]
			const inScope =
				target === document.body ||
				target === document.documentElement ||
				Boolean(shell && path.includes(shell))
			if (!card || !inScope) return
			// In fullscreen the certificate dialog portals into the shell. It
			// also keeps focus on its trigger inside the card, so an open dialog
			// anywhere owns the keys too.
			if (
				path.some((n) =>
					['dialog', 'alertdialog'].includes(
						(n as HTMLElement).getAttribute?.('role') ?? '',
					),
				) ||
				document.querySelector(
					'[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
				)
			)
				return
			const onControl = path.some(isControl)
			const proceed = () =>
				card.querySelector<HTMLElement>('[data-end-card-continue]')?.click()

			switch (e.key) {
				case 'Escape':
					dispatch({ type: 'HIDDEN' })
					break
				case 'Enter':
					// A focused control answers Enter itself.
					if (onControl) return
					proceed()
					break
				case 'N':
					if (!e.shiftKey) return
					proceed()
					break
				case 'k':
				case ' ':
					// The shell's page-wide play/pause would restart the ended
					// video under the card; it skips prevented events. A focused
					// button still takes Space natively.
					if (e.key === ' ' && onControl) return
					break
				default:
					return
			}
			e.preventDefault()
		}
		// Capture, so this runs before the shell's document listener.
		document.addEventListener('keydown', onKeyDown, true)
		return () => document.removeEventListener('keydown', onKeyDown, true)
	}, [dispatch, isPresent, inert])

	const scrim: Variants = {
		hidden: { opacity: 0 },
		shown: {
			opacity: 1,
			transition: { duration: 0.2, ease: easeOutQuint, staggerChildren: 0.04 },
		},
		exit: { opacity: 0, transition: { duration: 0.15, ease: easeOutQuint } },
	}

	return (
		<motion.div
			ref={ref}
			inert={inert}
			aria-live="polite"
			variants={scrim}
			initial="hidden"
			animate="shown"
			exit="exit"
			// Fixed light-on-dark: the card sits on the video frame, not the page.
			className={cn(
				// Size container: rows that need height (the thumbnail) query it.
				'absolute inset-0 z-40 flex flex-col [container-type:size] items-center justify-center gap-3 bg-black/75 p-5 text-center text-white backdrop-blur-md sm:gap-6',
				!isPresent && 'pointer-events-none',
			)}
		>
			{children}
			<button
				type="button"
				className="focus-visible:ring-ring absolute right-3 top-3 flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 sm:right-5 sm:top-5"
				onClick={() => dispatch({ type: 'HIDDEN' })}
			>
				<span className="sr-only">Dismiss</span>
				<XMarkIcon aria-hidden="true" className="size-5" />
			</button>
		</motion.div>
	)
}

/** One row of card content; rows rise in one after another. */
export function EndCardItem({
	className,
	children,
}: {
	className?: string
	children: React.ReactNode
}) {
	const reduceMotion = useReducedMotion()
	const item: Variants = {
		hidden: { opacity: 0, y: reduceMotion ? 0 : 8 },
		shown: {
			opacity: 1,
			y: 0,
			transition: { duration: 0.2, ease: easeOutQuint },
		},
	}
	return (
		<motion.div variants={item} className={className}>
			{children}
		</motion.div>
	)
}
