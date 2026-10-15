'use client'

import * as React from 'react'
import { formatSeconds } from '@/components/video-chapters/chapter-utils'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

import { cn } from '@coursebuilder/ui/utils/cn'

const easeOutQuint = [0.22, 1, 0.36, 1] as const

// Long enough to read and reach for, short enough to be gone before it
// competes with the lesson.
export const RESUME_CHIP_VISIBLE_MS = 5_000

/**
 * "Resumed at 4:32 · Start over", on the video frame. Tells the learner the
 * lesson picked up where they left off, and offers the way back to 0.
 *
 * Pass the position playback resumed from; `null` hides the chip, which is
 * how the player dismisses it when playback restarts some other way. It also
 * hides itself after a few seconds and once "Start over" is pressed.
 *
 * Drawn ON the video, so it uses fixed light-on-dark scrim colors like the
 * rest of the on-video UI in `player-gesture-shell.tsx`.
 */
export function ResumeChip({
	resumedAt,
	onStartOver,
	className,
}: {
	resumedAt: number | null
	onStartOver: () => void
	/** Positioning on the player; defaults to the top-left corner. */
	className?: string
}) {
	const prefersReducedMotion = useReducedMotion()
	const [dismissed, setDismissed] = React.useState(false)
	const [shownFor, setShownFor] = React.useState(resumedAt)

	// A new resume position is a new chip: show it again.
	if (shownFor !== resumedAt) {
		setShownFor(resumedAt)
		setDismissed(false)
	}

	const visible = resumedAt !== null && !dismissed

	React.useEffect(() => {
		if (!visible) return
		const timer = setTimeout(() => setDismissed(true), RESUME_CHIP_VISIBLE_MS)
		return () => clearTimeout(timer)
	}, [visible, resumedAt])

	const offset = prefersReducedMotion ? 0 : -4

	return (
		<AnimatePresence>
			{resumedAt !== null && !dismissed && (
				<motion.div
					key="resume-chip"
					role="status"
					initial={{ opacity: 0, y: offset }}
					animate={{ opacity: 1, y: 0 }}
					exit={{ opacity: 0, y: offset }}
					transition={{ duration: 0.2, ease: easeOutQuint }}
					className={cn(
						// On touch the shell pins the autoplay toggle in this corner
						// before play; sit below it.
						'pointer-coarse:top-12 absolute left-2 top-2 z-20 flex items-center gap-1.5 rounded-[9px] bg-black/60 py-1.5 pl-3 pr-1.5 text-sm text-white',
						className,
					)}
				>
					<span className="tabular-nums">
						Resumed at {formatSeconds(resumedAt)}
					</span>
					<span aria-hidden="true" className="text-white/50">
						·
					</span>
					<button
						type="button"
						onClick={() => {
							setDismissed(true)
							onStartOver()
						}}
						className="rounded-[6px] px-1.5 py-0.5 font-medium underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
					>
						Start over
					</button>
				</motion.div>
			)}
		</AnimatePresence>
	)
}
