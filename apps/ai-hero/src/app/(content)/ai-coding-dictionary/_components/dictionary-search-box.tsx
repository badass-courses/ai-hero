'use client'

import * as React from 'react'
import { Search, X } from 'lucide-react'
import { useSearchBox } from 'react-instantsearch'

export function DictionarySearchBox({
	scrollTargetId,
}: {
	scrollTargetId?: string
}) {
	const { query, refine } = useSearchBox()
	const inputRef = React.useRef<HTMLInputElement>(null)
	const wasSearchingRef = React.useRef(Boolean(query.trim()))

	React.useEffect(() => {
		const isSearching = Boolean(query.trim())
		const justStarted = isSearching && !wasSearchingRef.current
		wasSearchingRef.current = isSearching

		if (!justStarted || !scrollTargetId) return
		if (typeof window === 'undefined') return

		// Only scroll on viewports where the sidebar isn't side-by-side with
		// content. Above lg the desktop layout already shows results next to
		// the input, so any auto-scroll would be disorienting.
		const isCompact = window.matchMedia('(max-width: 1023px)').matches
		if (!isCompact) return

		const target = document.getElementById(scrollTargetId)
		target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
	}, [query, scrollTargetId])

	return (
		<div className="bg-background relative flex items-center">
			<Search
				aria-hidden
				className="text-muted-foreground pointer-events-none absolute left-5 size-4"
			/>
			<input
				ref={inputRef}
				type="search"
				value={query}
				onChange={(event) => refine(event.currentTarget.value)}
				placeholder="Search the dictionary..."
				aria-label="Search dictionary"
				autoComplete="off"
				spellCheck={false}
				className="placeholder:text-muted-foreground/80 h-14 w-full bg-transparent pl-12 pr-12 font-mono text-sm outline-none focus-visible:bg-muted/30 [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden [&::-webkit-search-results-button]:hidden [&::-webkit-search-results-decoration]:hidden"
			/>
			{query ? (
				<button
					type="button"
					onClick={() => {
						refine('')
						inputRef.current?.focus()
					}}
					aria-label="Clear search"
					className="text-muted-foreground hover:text-foreground absolute right-4 inline-flex size-6 items-center justify-center transition-colors"
				>
					<X aria-hidden className="size-4" />
				</button>
			) : null}
		</div>
	)
}
