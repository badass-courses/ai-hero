'use client'

import * as React from 'react'
import Spinner from '@/components/spinner'
import type { TypesenseResource } from '@/lib/typesense'
import { TYPESENSE_COLLECTION_NAME } from '@/utils/typesense-instantsearch-adapter'
import { useInfiniteHits, useInstantSearch } from 'react-instantsearch'

import { Button } from '@coursebuilder/ui'

/**
 * The homepage posts-grid layout (`ResourceGrid`) over infinite Typesense
 * hits. Loading slots are striped thumbnails, not gray skeletons (DESIGN
 * rule 15), and match a card's thumbnail so nothing reflows.
 */
export function VideoGrid({
	renderHit,
	emptyState,
}: {
	renderHit: (hit: TypesenseResource) => React.ReactNode
	emptyState: React.ReactNode
}) {
	const { items, showMore, isLastPage } = useInfiniteHits<TypesenseResource>(
		{},
	)
	const { status, uiState } = useInstantSearch()
	const sentinelRef = React.useRef<HTMLDivElement>(null)

	// A changed query, sort or filter replaces the grid; "show more" appends.
	const indexState = uiState[TYPESENSE_COLLECTION_NAME]
	const paramKey = JSON.stringify({
		query: indexState?.query ?? '',
		sortBy: indexState?.sortBy ?? '',
		filters: indexState?.configure?.filters ?? '',
	})
	const settledKeyRef = React.useRef(paramKey)
	const [paramsChanged, setParamsChanged] = React.useState(false)

	React.useEffect(() => {
		if (paramKey !== settledKeyRef.current) setParamsChanged(true)
	}, [paramKey])

	React.useEffect(() => {
		if (status === 'idle' && paramsChanged) {
			settledKeyRef.current = paramKey
			setParamsChanged(false)
		}
	}, [status, paramsChanged, paramKey])

	const isLoading = status === 'loading' || status === 'stalled'
	const showPlaceholders =
		(isLoading && paramsChanged) || (isLoading && items.length === 0)
	const isLoadingMore = isLoading && !showPlaceholders

	React.useEffect(() => {
		if (isLastPage) return
		const el = sentinelRef.current
		if (!el) return
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting && !isLastPage && !isLoading) showMore()
			},
			{ rootMargin: '600px 0px' },
		)
		observer.observe(el)
		return () => observer.disconnect()
	}, [isLastPage, showMore, isLoading])

	if (!showPlaceholders && items.length === 0) return <>{emptyState}</>

	return (
		<div className="pb-14 sm:pb-16">
			<ul
				className="grid w-full grid-cols-1 gap-5 px-[18px] pt-8 sm:grid-cols-2 sm:px-11 lg:grid-cols-3"
				aria-busy={showPlaceholders}
			>
				{showPlaceholders
					? Array.from({ length: 6 }).map((_, i) => (
							<li key={i} aria-hidden>
								<div className="bg-stripes aspect-video w-full rounded-[10px]" />
							</li>
						))
					: items.map((item) => <li key={item.objectID}>{renderHit(item)}</li>)}
			</ul>
			{!isLastPage && !showPlaceholders && (
				<>
					<div ref={sentinelRef} aria-hidden className="h-px w-full" />
					<Button
						variant="ghost"
						onClick={showMore}
						disabled={isLoadingMore}
						className="mt-6 flex h-14 w-full items-center justify-center gap-2 font-semibold"
						aria-busy={isLoadingMore}
					>
						{isLoadingMore ? (
							<>
								<Spinner className="h-4 w-4" aria-hidden />
								<span>Loading more…</span>
							</>
						) : (
							'Show more'
						)}
					</Button>
				</>
			)}
		</div>
	)
}
