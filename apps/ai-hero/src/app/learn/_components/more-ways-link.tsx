import * as React from 'react'
import Link from 'next/link'
import { TYPE } from '@/components/landing/type'
import { ArrowRight } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

/**
 * "More ways to X" footer link for a Map goal section — the app's secondary
 * button, the same one `/courses` uses for "See team options": 44px tall, 9px
 * radius, hairline border, lucide arrow that steps on hover.
 *
 * It used to be an 18/20px semibold editorial link trailed by
 * `AnimatedArrowCircle`, which predates the redesign: the size came from inline
 * classes rather than `TYPE` (DESIGN rule 10), and at that weight it competed
 * with the section heading above it instead of reading as the quiet way out of
 * a finished list. The prototype draws it as a small outlined control.
 *
 * No longer a client component — dropping framer-motion for a CSS transition
 * means the whole footer row renders on the server.
 *
 * `label` may carry a trailing " →" (the config authors it that way); it is
 * stripped here so the icon is the only arrow.
 */
export function MoreWaysLink({
	href,
	label,
	className,
}: {
	href: string
	label: string
	/** Placement only — the control's own look is not the caller's business. */
	className?: string
}) {
	const text = label.replace(/\s*→\s*$/, '')
	return (
		<Link
			href={href}
			className={cn(
				TYPE.meta,
				'border-foreground/20 hover:bg-secondary focus-visible:ring-ring group inline-flex h-11 w-fit shrink-0 items-center gap-2 rounded-[9px] border px-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
				className,
			)}
		>
			{text}
			<ArrowRight
				aria-hidden
				className="ease-out-quart size-4 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
			/>
		</Link>
	)
}
