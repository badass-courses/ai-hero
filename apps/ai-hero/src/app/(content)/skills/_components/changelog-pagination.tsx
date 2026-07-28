import * as React from 'react'
import Link from 'next/link'
import { TYPE } from '@/components/landing/type'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

/**
 * Older/newer for the changelog table. It sits INSIDE the section's padded
 * column now (the table is capped at 960px), so it carries no gutter and no
 * rule of its own — the table's last hairline is already the line above it.
 */
export function ChangelogPagination({
	currentPage,
	totalPages,
}: {
	currentPage: number
	totalPages: number
}) {
	if (totalPages <= 1) return null

	const hasNewer = currentPage > 1
	const hasOlder = currentPage < totalPages

	return (
		<nav
			aria-label="AI skills changelog pagination"
			className="flex max-w-[960px] items-center justify-between gap-3 pt-6"
		>
			{hasNewer ? (
				<PageLink href={`/skills?page=${currentPage - 1}`} direction="newer" />
			) : (
				<span aria-hidden />
			)}
			<span className={cn(TYPE.command, 'text-[color:var(--ah-fg-subtle)]')}>
				Page {currentPage} of {totalPages}
			</span>
			{hasOlder ? (
				<PageLink href={`/skills?page=${currentPage + 1}`} direction="older" />
			) : (
				<span aria-hidden />
			)}
		</nav>
	)
}

function PageLink({
	href,
	direction,
}: {
	href: string
	direction: 'newer' | 'older'
}) {
	const isNewer = direction === 'newer'
	return (
		<Link
			href={href}
			className={cn(
				TYPE.meta,
				'border-input hover:bg-muted focus-visible:ring-ring inline-flex items-center gap-2 rounded-[9px] border px-4 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
			)}
		>
			{isNewer ? (
				<>
					<ChevronLeft className="size-3.5" aria-hidden /> Newer
				</>
			) : (
				<>
					Older <ChevronRight className="size-3.5" aria-hidden />
				</>
			)}
		</Link>
	)
}
