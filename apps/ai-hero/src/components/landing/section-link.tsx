import * as React from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

/**
 * Trailing "see more" link under a section (wireframe § ⑤ ⑨ ⑩).
 *
 * A component rather than a bare markdown `[label](/href)`: top-level MDX
 * links render with no wrapper, so they sit flush against the container's
 * `border-x` while every neighbouring section is padded. This owns the
 * padding and the arrow treatment so all three read identically.
 */
export function SectionLink({
	href,
	children,
}: {
	href: string
	children: React.ReactNode
}) {
	return (
		<div className="border-b px-8 py-8 sm:px-11">
			<Link
				href={href}
				className="group text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
			>
				{children}
				<ArrowRight
					aria-hidden
					className="ease-out-quart size-3.5 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
				/>
			</Link>
		</div>
	)
}
