'use client'

import * as React from 'react'
import {
	useInfiniteHits,
	useInstantSearch,
	useSearchBox,
} from 'react-instantsearch'

import type { TypesenseResource } from '@/lib/typesense'

import { DictionaryHit } from './dictionary-hit'

export function DictionarySearchResults() {
	const { items, isLastPage, showMore } = useInfiniteHits<TypesenseResource>({})
	const { status } = useInstantSearch()
	const { query: rawQuery } = useSearchBox()
	const query = rawQuery.trim()
	const sentinelRef = React.useRef<HTMLDivElement>(null)
	const isLoading = status === 'loading' || status === 'stalled'

	React.useEffect(() => {
		if (isLastPage) return
		const el = sentinelRef.current
		if (!el) return
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting && !isLoading) showMore()
			},
			{ rootMargin: '400px 0px' },
		)
		observer.observe(el)
		return () => observer.disconnect()
	}, [isLastPage, isLoading, showMore])

	if (items.length === 0 && !isLoading) {
		return (
			<div className="flex flex-col items-center gap-3 px-8 py-24 text-center">
				<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					No matches
				</p>
				<p className="text-muted-foreground max-w-md text-balance text-base">
					Nothing in the dictionary matches{' '}
					<strong className="text-foreground font-mono">"{query}"</strong>.
					Clear search to browse by section.
				</p>
			</div>
		)
	}

	const showSkeletons = isLoading && items.length === 0

	return (
		<div aria-busy={isLoading || undefined} aria-live="polite">
			<div className="border-border flex items-center justify-between border-b px-6 py-3 sm:px-8">
				<p className="text-muted-foreground font-mono text-[10px] font-medium uppercase tracking-wider">
					{showSkeletons
						? 'Searching…'
						: `${items.length} ${items.length === 1 ? 'match' : 'matches'} for "${query}"`}
				</p>
			</div>
			<div className="bg-border grid grid-cols-1 gap-px sm:grid-cols-2">
				{showSkeletons ? (
					<>
						{Array.from({ length: 6 }).map((_, i) => (
							<SkeletonHit key={`skeleton-${i}`} />
						))}
					</>
				) : (
					<>
						{items.map((hit) => (
							<DictionaryHit key={hit.objectID} hit={hit} />
						))}
						{items.length % 2 === 1 ? (
							<div aria-hidden className="bg-background hidden sm:block" />
						) : null}
					</>
				)}
			</div>
			{!isLastPage && !showSkeletons ? (
				<div ref={sentinelRef} aria-hidden className="h-px w-full" />
			) : null}
		</div>
	)
}

function SkeletonHit() {
	return (
		<div
			aria-hidden
			className="bg-background relative flex h-full min-h-32 animate-pulse flex-col gap-3 p-6 sm:p-7"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="bg-muted/70 h-5 w-2/3 sm:h-6" />
				<div className="bg-muted/70 size-4 shrink-0 translate-y-0.5" />
			</div>
			<div className="flex flex-col gap-1.5">
				<div className="bg-muted/50 h-3 w-full" />
				<div className="bg-muted/50 h-3 w-11/12" />
				<div className="bg-muted/50 h-3 w-2/3" />
			</div>
		</div>
	)
}
