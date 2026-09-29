'use client'

import * as React from 'react'
import Link from 'next/link'
import { SearchBox } from '@/app/(search)/q/_components/instantsearch/searchbox'
import { SortBy } from '@/app/(search)/q/_components/instantsearch/sort-by'
import {
	MOST_POPULAR_SORT_VALUE,
	NEWEST_SORT_VALUE,
	RELEVANCE_SORT_VALUE,
} from '@/app/(search)/q/_components/instantsearch/sort-options'
import { TYPE } from '@/components/landing/type'
import {
	buildVideoSearchFilter,
	parseVideoAccess,
	type VideoAccess,
} from '@/lib/video-search-filter'
import {
	EMPTY_VIDEO_VIEWER_STATUS,
	type VideoViewerStatus,
} from '@/lib/video-viewer-status'
import { api } from '@/trpc/react'
import {
	TYPESENSE_COLLECTION_NAME,
	typesenseInstantsearchAdapter,
} from '@/utils/typesense-instantsearch-adapter'
import { parseAsBoolean, useQueryState } from 'nuqs'
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary'
import { Configure, useInstantSearch } from 'react-instantsearch'
import { InstantSearchNext } from 'react-instantsearch-nextjs'

import { Button, Label, Switch } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { VideoCard } from './video-card'
import { VideoGrid } from './video-grid'

// Relevance is what a typed search switches to (as on /posts), so it has to
// be a listed option or the button reads "Sort by..." mid-search.
const SORT_ITEMS = [
	{ value: NEWEST_SORT_VALUE, label: 'Newest first' },
	{ value: MOST_POPULAR_SORT_VALUE, label: 'Most Popular' },
	{ value: RELEVANCE_SORT_VALUE, label: 'Relevance' },
]
const SORT_KEY_TO_VALUE: Record<string, string> = {
	newest: NEWEST_SORT_VALUE,
	popular: MOST_POPULAR_SORT_VALUE,
	relevance: RELEVANCE_SORT_VALUE,
}
const SORT_VALUE_TO_KEY: Record<string, string> = Object.fromEntries(
	Object.entries(SORT_KEY_TO_VALUE).map(([key, value]) => [value, key]),
)

const HITS_PER_PAGE = 40
const ACCESS_OPTIONS: Array<{ value: VideoAccess; label: string }> = [
	{ value: 'all', label: 'All' },
	{ value: 'owned', label: 'My courses' },
]

const ErrorFallback = ({ error }: FallbackProps) => (
	<div className="px-[18px] py-12 sm:px-11">
		<p className={TYPE.body}>
			{error instanceof Error && error.message
				? error.message
				: 'Videos could not load.'}
		</p>
		<Button
			variant="outline"
			className="mt-4"
			onClick={() => window.location.reload()}
		>
			Try again
		</Button>
	</div>
)

export function VideoSearch() {
	return (
		<ErrorBoundary FallbackComponent={ErrorFallback}>
			<VideoSearchState />
		</ErrorBoundary>
	)
}

/**
 * URL state and the viewer's status live here, OUTSIDE InstantSearchNext: nuqs
 * has no adapter during its server-side getServerState pass, and reading it
 * inside drops the Configure filter on the SSR render (see the /posts
 * `Search`). Everything the filter depends on is resolved here and passed in.
 */
function VideoSearchState() {
	const [query, setQuery] = useQueryState('q')
	const [sort, setSort] = useQueryState('sort')
	const [accessParam, setAccessParam] = useQueryState('access')
	const [hideWatchedParam, setHideWatched] = useQueryState(
		'hide-watched',
		parseAsBoolean.withDefault(false),
	)

	const { data, isError, refetch } = api.videos.viewerStatus.useQuery(undefined, {
		staleTime: 60_000,
		refetchOnWindowFocus: false,
		retry: 1,
	})
	// A failed status is an empty one, so the page degrades to what an
	// anonymous visitor sees rather than waiting on ids that are never coming.
	const statusFailed = isError && !data
	const status = data ?? (statusFailed ? EMPTY_VIDEO_VIEWER_STATUS : null)
	// "My courses" and "Hide watched" only apply once the viewer is known to own
	// or have watched something. Otherwise a shared `?access=owned` link, or a
	// failed status, filters everything out and the grid calls it "watched".
	// Both stay in the URL, so a successful retry restores them.
	const access =
		status && status.ownedIds.length === 0
			? 'all'
			: parseVideoAccess(accessParam)
	const hideWatched =
		hideWatchedParam && (status === null || status.watchedIds.length > 0)

	const filters = buildVideoSearchFilter({
		access,
		ownedIds: status?.ownedIds ?? null,
		hiddenIds: hideWatched ? (status?.watchedIds ?? null) : [],
	})
	const statusPending = status === null && (access === 'owned' || hideWatched)

	const initialUiState = {
		[TYPESENSE_COLLECTION_NAME]: {
			query: query || '',
			sortBy: (sort && SORT_KEY_TO_VALUE[sort]) || NEWEST_SORT_VALUE,
			configure: { filters, hitsPerPage: HITS_PER_PAGE },
		},
	}

	return (
		<InstantSearchNext
			searchClient={typesenseInstantsearchAdapter.searchClient}
			indexName={TYPESENSE_COLLECTION_NAME}
			routing={false}
			onStateChange={({ uiState, setUiState }) => {
				const indexState = uiState[TYPESENSE_COLLECTION_NAME]
				setQuery(indexState?.query || null)
				const sortKey = indexState?.sortBy
					? SORT_VALUE_TO_KEY[indexState.sortBy]
					: undefined
				setSort(sortKey && sortKey !== 'newest' ? sortKey : null)
				setUiState(uiState)
			}}
			initialUiState={initialUiState}
			future={{ preserveSharedStateOnUnmount: true }}
		>
			<VideoSearchContent
				filters={filters}
				access={access}
				onAccessChange={(value) =>
					setAccessParam(value === 'all' ? null : value)
				}
				status={status}
				statusPending={statusPending}
				hideWatched={hideWatched}
				onHideWatchedChange={(value) => setHideWatched(value || null)}
				statusFailed={statusFailed}
				onRetryStatus={() => void refetch()}
			/>
		</InstantSearchNext>
	)
}

function VideoSearchContent({
	filters,
	access,
	onAccessChange,
	status,
	statusPending,
	hideWatched,
	onHideWatchedChange,
	statusFailed,
	onRetryStatus,
}: {
	filters: string
	access: VideoAccess
	onAccessChange: (value: VideoAccess) => void
	status: VideoViewerStatus | null
	statusPending: boolean
	hideWatched: boolean
	onHideWatchedChange: (value: boolean) => void
	statusFailed: boolean
	onRetryStatus: () => void
}) {
	const { refresh, uiState, setIndexUiState } = useInstantSearch()

	React.useEffect(() => {
		refresh()
	}, [refresh])

	// Same as /posts: a typed query wants relevance, browsing wants newest.
	// setIndexUiState rather than a second useSortBy, which breaks SSR.
	const hasQuery = !!uiState[TYPESENSE_COLLECTION_NAME]?.query?.trim()
	const prevHasQuery = React.useRef(hasQuery)
	React.useEffect(() => {
		if (hasQuery !== prevHasQuery.current) {
			prevHasQuery.current = hasQuery
			setIndexUiState((prev) => ({
				...prev,
				sortBy: hasQuery ? RELEVANCE_SORT_VALUE : NEWEST_SORT_VALUE,
			}))
		}
	}, [hasQuery, setIndexUiState])

	// "My courses" only means something to someone who owns one.
	const showAccess = access === 'owned' || (status?.ownedIds.length ?? 0) > 0
	const canHideWatched = hideWatched || (status?.watchedIds.length ?? 0) > 0

	return (
		<>
			<Configure
				filters={filters}
				hitsPerPage={HITS_PER_PAGE}
				// Hybrid (keyword + semantic) only with a query; embedding an empty
				// string errors at the provider.
				{...(hasQuery
					? {
							query_by: 'title,description,summary,embedding',
							prefix: 'true,true,true,false',
						}
					: {})}
			/>
			<div className="bg-background/90 top-(--nav-height) z-10 flex flex-col gap-3 border-y px-[18px] py-3 backdrop-blur-lg sm:sticky sm:flex-row sm:items-center sm:gap-3 sm:px-11">
				<div className="w-full sm:flex-1">
					<SearchBox />
				</div>
				<div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:flex-nowrap sm:gap-3">
					{showAccess && (
						<div
							role="radiogroup"
							aria-label="Show"
							className="border-input flex h-9 shrink-0 items-center rounded-[9px] border p-0.5"
						>
							{ACCESS_OPTIONS.map((option) => (
								<Button
									key={option.value}
									role="radio"
									aria-checked={access === option.value}
									variant={access === option.value ? 'secondary' : 'ghost'}
									size="sm"
									className="h-full rounded-[7px] px-3"
									onClick={() => onAccessChange(option.value)}
								>
									{option.label}
								</Button>
							))}
						</div>
					)}
					<div className="min-w-0 flex-1 sm:w-40 sm:flex-none">
						<SortBy items={SORT_ITEMS} />
					</div>
					{canHideWatched && (
						<div className="flex shrink-0 items-center gap-2">
							<Switch
								id="videos-hide-watched"
								checked={hideWatched}
								onCheckedChange={onHideWatchedChange}
							/>
							<Label htmlFor="videos-hide-watched" className={TYPE.meta}>
								Hide watched
							</Label>
						</div>
					)}
				</div>
			</div>
			{statusFailed && (
				<p
					role="status"
					className={cn(
						TYPE.metaProse,
						'text-muted-foreground px-[18px] pt-6 sm:px-11',
					)}
				>
					Your courses and progress did not load, so only free videos are
					showing.{' '}
					<button
						type="button"
						onClick={onRetryStatus}
						className="text-foreground underline underline-offset-4"
					>
						Try again
					</button>
				</p>
			)}
			<VideoGrid
				renderHit={(hit) => (
					<VideoCard hit={hit} status={status} />
				)}
				emptyState={
					statusPending ? null : (
						<EmptyState
							hideWatched={hideWatched}
							onShowWatched={() => onHideWatchedChange(false)}
						/>
					)
				}
			/>
		</>
	)
}

function EmptyState({
	hideWatched,
	onShowWatched,
}: {
	hideWatched: boolean
	onShowWatched: () => void
}) {
	const { uiState } = useInstantSearch()
	const query = uiState[TYPESENSE_COLLECTION_NAME]?.query?.trim()

	return (
		<div className="border-b px-[18px] py-12 sm:px-11 md:py-[52px]">
			{query ? (
				<p className={cn(TYPE.body, 'text-muted-foreground')}>
					No videos match &ldquo;{query}&rdquo;.{' '}
					<Link
						href={`/q?q=${encodeURIComponent(query)}`}
						className="text-foreground underline underline-offset-4"
					>
						Search everything on AI Hero
					</Link>
				</p>
			) : hideWatched ? (
				<p className={cn(TYPE.body, 'text-muted-foreground')}>
					You have watched everything here.{' '}
					<button
						type="button"
						onClick={onShowWatched}
						className="text-foreground underline underline-offset-4"
					>
						Show watched videos
					</button>
				</p>
			) : (
				<p className={cn(TYPE.body, 'text-muted-foreground')}>
					Nothing here yet.
				</p>
			)}
		</div>
	)
}
