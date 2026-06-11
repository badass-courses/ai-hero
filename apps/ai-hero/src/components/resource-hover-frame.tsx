import * as React from 'react'
import { cn } from '@coursebuilder/utils/cn'

const GRADIENT_IMAGE =
	'linear-gradient(90deg, oklch(0.92 0.05 30), oklch(0.74 0.18 50), oklch(0.82 0.12 350), oklch(0.50 0.20 260), oklch(0.85 0.10 5), oklch(0.92 0.07 145), oklch(0.74 0.18 50), oklch(0.88 0.18 95), oklch(0.62 0.22 25), oklch(0.74 0.18 45), oklch(0.82 0.12 350), oklch(0.92 0.05 30))'

/**
 * Signature hover effect from landing's ResourceRow: animated rainbow gradient
 * revealed behind an inset surface layer, producing a thin colorful border on
 * hover.
 *
 * The interactive parent (Link, button, etc.) MUST carry `group/resource`
 * AND `relative` so this can anchor and respond to hover. The positioning and
 * hover transitions are defined in `globals.css` to guarantee uniform 5px
 * strips on all four sides.
 *
 * `surfaceClassName` sets the inset layer's background — match whatever
 * surface the parent sits on (`bg-background`, `bg-popover`, …).
 */
export function ResourceHoverFrame({
	children,
	surfaceClassName = 'bg-background',
	className,
}: {
	children: React.ReactNode
	surfaceClassName?: string
	className?: string
}) {
	return (
		<>
			<div
				aria-hidden
				className="resource-hover-frame-gradient animate-resource-gradient"
				style={{
					backgroundImage: GRADIENT_IMAGE,
					backgroundSize: '200% 200%',
				}}
			/>
			<div
				aria-hidden
				className={cn('resource-hover-frame-surface', surfaceClassName)}
			/>
			<div className={cn('relative', className)}>{children}</div>
		</>
	)
}
