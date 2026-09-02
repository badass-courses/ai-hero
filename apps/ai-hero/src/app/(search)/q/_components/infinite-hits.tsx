'use client'

import * as React from 'react'
import Spinner from '@/components/spinner'
import type { TypesenseResource } from '@/lib/typesense'
import { TYPESENSE_COLLECTION_NAME } from '@/utils/typesense-instantsearch-adapter'
import { useInfiniteHits, useInstantSearch } from 'react-instantsearch'

import { Button } from '@coursebuilder/ui'

import Hit from './instantsearch/hit'

// Mirrors <Hit> exactly — same row borders, same paddings, same thumbnail
// radius — so the list does not reflow when real results replace it.
function SkeletonItem() {
	return (
		<li className="border-border -mt-px block animate-pulse border-y">
			<div className="relative flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:gap-8 sm:px-14 sm:py-10">
				<div className="bg-muted aspect-video w-full shrink-0 rounded-lg sm:w-60" />
				<div className="flex flex-1 flex-col gap-2.5">
					<div className="h-3 w-24 rounded-sm bg-[color:var(--ah-line-strong)]" />
					<div className="h-7 w-4/5 rounded-sm bg-[color:var(--ah-line-strong)] sm:h-9" />
					<div className="h-4 w-full rounded-sm bg-[color:var(--ah-line-strong)]" />
					<div className="h-4 w-3/5 rounded-sm bg-[color:var(--ah-line-strong)]" />
				</div>
				<div className="hidden h-12 w-12 shrink-0 rounded-full bg-[color:var(--ah-line-strong)] sm:block" />
			</div>
		</li>
	)
}

export function InfiniteHits() {
	const { items, showMore, isLastPage } = useInfiniteHits<TypesenseResource>({})
	const { status, uiState } = useInstantSearch()
	const sentinelRef = React.useRef<HTMLDivElement>(null)

	// Detect when search parameters (sort, query, filters) have changed but the
	// new results haven't settled yet. This is the "full refresh" signal that
	// distinguishes a sort/filter/query change (skeleton the whole list) from a
	// "Show More" pagination (append, keep current items).
	const indexState = uiState[TYPESENSE_COLLECTION_NAME]
	const paramKey = JSON.stringify({
		query: indexState?.query ?? '',
		sortBy: indexState?.sortBy ?? '',
		refinementList: indexState?.refinementList ?? {},
	})
	const lastSettledParamKeyRef = React.useRef(paramKey)
	const [paramsChanged, setParamsChanged] = React.useState(false)

	React.useEffect(() => {
		if (paramKey !== lastSettledParamKeyRef.current) {
			setParamsChanged(true)
		}
	}, [paramKey])

	React.useEffect(() => {
		if (status === 'idle' && paramsChanged) {
			lastSettledParamKeyRef.current = paramKey
			setParamsChanged(false)
		}
	}, [status, paramsChanged, paramKey])

	const isLoading = status === 'loading' || status === 'stalled'
	const isFullRefresh = isLoading && paramsChanged
	const isInitialLoad = isLoading && items.length === 0 && !paramsChanged
	const showFullSkeleton = isFullRefresh || isInitialLoad
	const isLoadingMore = isLoading && !showFullSkeleton && items.length > 0

	React.useEffect(() => {
		if (isLastPage) return
		const el = sentinelRef.current
		if (!el) return
		const observer = new IntersectionObserver(
			(entries) => {
				const entry = entries[0]
				if (entry?.isIntersecting && !isLastPage && !isLoading) {
					showMore()
				}
			},
			{ rootMargin: '400px 0px' },
		)
		observer.observe(el)
		return () => observer.disconnect()
	}, [isLastPage, showMore, isLoading])

	if (showFullSkeleton) {
		return (
			<div aria-live="polite" aria-busy>
				<span className="sr-only">Loading results...</span>
				<ul>
					{Array.from({ length: 5 }).map((_, i) => (
						<SkeletonItem key={i} />
					))}
				</ul>
			</div>
		)
	}

	return (
		<div>
			<ul>
				{items.map((item) => (
					<Hit key={item.objectID} hit={item} />
				))}
			</ul>
			{!isLastPage && (
				<>
					<div ref={sentinelRef} aria-hidden className="h-px w-full" />
					<Button
						variant="ghost"
						onClick={showMore}
						disabled={isLoadingMore}
						className="flex h-20 w-full items-center justify-center gap-2 font-semibold"
						aria-busy={isLoadingMore}
					>
						{isLoadingMore ? (
							<>
								<Spinner className="h-4 w-4" aria-hidden />
								<span>Loading more…</span>
							</>
						) : (
							'Show More'
						)}
					</Button>
				</>
			)}
		</div>
	)
}
