import Link from 'next/link'
import { ChevronRight } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

export type Crumb = {
	label: string
	/** Omit on the current (last) page. */
	href?: string
}

/**
 * Breadcrumb trail for nested hub/content pages. Presentational and on-brand
 * (mono micro-label, tokens, square). The last item renders as the current
 * page. See plans/navigation-redesign.md (Phase 3).
 */
export function Breadcrumbs({
	items,
	className,
}: {
	items: Crumb[]
	className?: string
}) {
	if (items.length === 0) return null

	return (
		<nav aria-label="Breadcrumb" className={cn('flex items-center', className)}>
			<ol className="text-muted-foreground flex flex-wrap items-center gap-1.5 font-mono text-xs">
				{items.map((item, i) => {
					const isLast = i === items.length - 1
					return (
						<li key={`${item.label}-${i}`} className="flex items-center gap-1.5">
							{item.href && !isLast ? (
								<Link
									href={item.href}
									className="hover:text-foreground focus-visible:ring-ring rounded-sm underline-offset-4 transition hover:underline focus-visible:outline-none focus-visible:ring-2"
								>
									{item.label}
								</Link>
							) : (
								<span
									aria-current={isLast ? 'page' : undefined}
									className={cn(isLast && 'text-foreground')}
								>
									{item.label}
								</span>
							)}
							{!isLast && (
								<ChevronRight aria-hidden className="size-3 opacity-60" />
							)}
						</li>
					)
				})}
			</ol>
		</nav>
	)
}
