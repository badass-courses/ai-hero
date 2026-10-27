import * as React from 'react'
import { ArrowRight } from 'lucide-react'

/**
 * The arrow in a ring that draws itself when the row is hovered.
 *
 * CSS, not framer-motion: `pathLength="1"` normalises the circle's length so
 * a dash of 1 with an offset of 1 is a hidden stroke and an offset of 0 is
 * the full ring; `group-hover` on the row link drives it. Same 500ms and
 * easing as the motion variants it replaces. This and the row's own hover
 * wash were the homepage's last framer-motion imports.
 */
export function AnimatedArrowCircle() {
	return (
		<span
			aria-hidden
			className="relative flex h-12 w-12 shrink-0 items-center justify-center sm:h-[54px] sm:w-[54px]"
		>
			<svg
				viewBox="0 0 54 54"
				className="absolute inset-0 h-full w-full"
				fill="none"
			>
				<circle
					cx="27"
					cy="27"
					r="26"
					stroke="currentColor"
					strokeWidth="1"
					className="text-foreground/20"
				/>
				<circle
					cx="27"
					cy="27"
					r="26"
					pathLength="1"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
					className="text-foreground opacity-0 transition-[stroke-dashoffset,opacity] duration-500 ease-[cubic-bezier(0.65,0,0.35,1)] [stroke-dasharray:1] [stroke-dashoffset:1] group-hover:opacity-100 group-hover:[stroke-dashoffset:0] motion-reduce:transition-none"
					style={{ transform: 'rotate(-90deg)', transformOrigin: '50% 50%' }}
				/>
			</svg>
			<ArrowRight className="relative h-4 w-4 sm:h-5 sm:w-5" />
		</span>
	)
}
