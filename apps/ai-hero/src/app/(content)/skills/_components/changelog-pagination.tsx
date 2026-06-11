import * as React from 'react'
import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'

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
			className="border-border flex items-center justify-between gap-3 border-t px-5 py-6 sm:px-14 sm:py-8"
		>
			{hasNewer ? (
				<PageLink href={`/skills?page=${currentPage - 1}`} direction="newer" />
			) : (
				<span aria-hidden />
			)}
			<span className="font-mono text-xs uppercase tracking-wider opacity-60">
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
			className="border-border hover:bg-muted/40 inline-flex items-center gap-2 border px-4 py-2 font-mono text-xs font-bold uppercase tracking-wider transition-colors"
		>
			{isNewer ? (
				<>
					<ChevronLeft className="size-3.5" /> Newer
				</>
			) : (
				<>
					Older <ChevronRight className="size-3.5" />
				</>
			)}
		</Link>
	)
}
