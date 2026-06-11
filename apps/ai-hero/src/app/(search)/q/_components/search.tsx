'use client'

import React from 'react'
import Link from 'next/link'
import { PostsGraph } from '@/components/posts-graph/posts-graph'
import type { PostsGraph as PostsGraphData } from '@/lib/posts-graph'
import {
	TYPESENSE_COLLECTION_NAME,
	typesenseInstantsearchAdapter,
} from '@/utils/typesense-instantsearch-adapter'
import { List, Rss, Waypoints } from 'lucide-react'
import { useQueryState } from 'nuqs'
import { ErrorBoundary, FallbackProps } from 'react-error-boundary'
import { Configure, useInstantSearch } from 'react-instantsearch'
import { InstantSearchNext } from 'react-instantsearch-nextjs'

import {
	Button,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from '@coursebuilder/ui'

import { InfiniteHits } from './infinite-hits'
import ClearRefinements from './instantsearch/clear-refinements'
import { RefinementList } from './instantsearch/refinement-list'
import { SearchBox } from './instantsearch/searchbox'
import { SortBy } from './instantsearch/sort-by'
import {
	DEFAULT_SORT_VALUE,
	MOST_POPULAR_SORT_VALUE,
	NEWEST_SORT_VALUE,
	OLDEST_SORT_VALUE,
	RELEVANCE_SORT_VALUE,
} from './instantsearch/sort-options'

// Short URL-friendly aliases for the (long) Typesense sort values.
const SORT_KEY_TO_VALUE: Record<string, string> = {
	newest: NEWEST_SORT_VALUE,
	popular: MOST_POPULAR_SORT_VALUE,
	relevance: RELEVANCE_SORT_VALUE,
	oldest: OLDEST_SORT_VALUE,
}
const SORT_VALUE_TO_KEY: Record<string, string> = Object.fromEntries(
	Object.entries(SORT_KEY_TO_VALUE).map(([k, v]) => [v, k]),
)

// Only public + published content (excludes unlisted/private and dictionary
// entries). Seeded into initialUiState so it applies on the very first SSR
// render, not just once the <Configure> widget mounts client-side.
const SEARCH_FILTER =
	'visibility:=public && state:=published && type:!=[dictionary,dictionary-entry]'

const hitsPerPageItems = [
	{
		label: '15 per page',
		value: 15,
		default: true,
	},
	{
		label: '30 per page',
		value: 30,
	},
]

/** Returns `value` only after it has stayed unchanged for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
	const [debounced, setDebounced] = React.useState(value)
	React.useEffect(() => {
		const id = setTimeout(() => setDebounced(value), ms)
		return () => clearTimeout(id)
	}, [value, ms])
	return debounced
}

const ErrorFallback = ({ error }: FallbackProps) => (
	<div className="rounded-lg border border-red-200 bg-red-50 p-4">
		<h3 className="font-semibold text-red-800">Search Error</h3>
		<p className="text-red-600">
			{error.message || 'An error occurred while loading search'}
		</p>
		<button
			onClick={() => window.location.reload()}
			className="mt-2 rounded bg-red-100 px-4 py-2 text-red-800 hover:bg-red-200"
		>
			Try Again
		</button>
	</div>
)

function SearchWithErrorBoundary({ graph }: { graph?: PostsGraphData }) {
	return (
		<ErrorBoundary FallbackComponent={ErrorFallback}>
			<Search graph={graph} />
		</ErrorBoundary>
	)
}

export default SearchWithErrorBoundary

function SearchContent({
	graph,
	view,
	setView,
}: {
	graph?: PostsGraphData
	view: 'list' | 'graph'
	setView: (v: 'list' | 'graph') => void
}) {
	const { refresh, uiState, results, setIndexUiState } = useInstantSearch()
	const hasGraph = !!graph && graph.nodes.length > 0

	React.useEffect(() => {
		refresh()
	}, [refresh])

	// A keyword search wants relevance (the hybrid keyword+semantic ranking);
	// browsing with no query wants newest. Auto-default the sort on that
	// transition. We use setIndexUiState (NOT a second useSortBy) — a second
	// useSortBy connector breaks InstantSearchNext's server-side getServerState
	// (the sort values are virtual replica indices), which drops the Configure
	// filter and leaks unlisted/private content on the initial SSR render.
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

	// In graph view, the graph is filtered by the live Typesense results: when a
	// query or type refinement is active, only matching documents stay.
	const indexState = uiState[TYPESENSE_COLLECTION_NAME]
	const hasActiveFilter =
		!!indexState?.query?.trim() ||
		(indexState?.refinementList?.type?.length ?? 0) > 0
	// The graph only contains nodes with embeddings, so intersect the search hits
	// with the graph's own ids and keep the most relevant ones.
	const graphIds = React.useMemo(
		() => new Set((graph?.nodes ?? []).map((n) => n.id)),
		[graph],
	)
	const matchIds =
		view === 'graph' && hasActiveFilter
			? (results?.hits ?? [])
					.map((h: any) => String(h.objectID ?? h.id))
					.filter((id) => graphIds.has(id))
					.slice(0, 20)
			: null
	// Debounce so the graph only re-filters / re-simulates after typing settles.
	const matchKey = matchIds ? matchIds.join(',') : null
	const debouncedKey = useDebounced(matchKey, 350)
	const debouncedMatchIds = debouncedKey ? debouncedKey.split(',') : null

	return (
		<>
			<Configure
				filters={SEARCH_FILTER}
				hitsPerPage={view === 'graph' ? 250 : 40}
				// Hybrid (keyword + semantic) only when there's a query — embedding an
				// empty string errors at the provider, which breaks plain browsing.
				{...(hasQuery
					? {
							query_by: 'title,description,summary,embedding',
							prefix: 'true,true,true,false',
						}
					: {})}
			/>
			<div className="bg-background/90 top-(--nav-height) z-10 flex flex-col border-y px-4 pb-4 backdrop-blur-lg sm:sticky sm:flex-row sm:items-center sm:gap-x-3 sm:border-t-0 sm:pb-0">
				<div className="w-full sm:flex-1">
					<SearchBox />
				</div>
				<div className="flex w-full items-center gap-2 sm:w-auto sm:shrink-0 sm:gap-3">
					<div className="min-w-0 flex-1 sm:w-36 sm:flex-none">
						<RefinementList attribute="type" label="Type" />
					</div>
					<div className="min-w-0 flex-1 sm:w-40 sm:flex-none">
						<SortBy />
					</div>
					{hasGraph && (
						<TooltipProvider delayDuration={0}>
							<div className="flex h-9 shrink-0 items-center rounded-md border p-0.5">
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											variant={view === 'list' ? 'secondary' : 'ghost'}
											size="icon"
											className="aspect-square h-full w-auto"
											onClick={() => setView('list')}
											aria-label="List view"
											aria-pressed={view === 'list'}
										>
											<List className="size-4" />
										</Button>
									</TooltipTrigger>
									<TooltipContent side="bottom">List view</TooltipContent>
								</Tooltip>
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											variant={view === 'graph' ? 'secondary' : 'ghost'}
											size="icon"
											className="aspect-square h-full w-auto"
											onClick={() => setView('graph')}
											aria-label="Graph view"
											aria-pressed={view === 'graph'}
										>
											<Waypoints className="size-4" />
										</Button>
									</TooltipTrigger>
									<TooltipContent side="bottom">Graph View</TooltipContent>
								</Tooltip>
							</div>
						</TooltipProvider>
					)}
					<Button variant="outline" asChild className="shrink-0">
						<Link
							href="/rss.xml"
							className="flex items-center justify-center gap-1"
							target="_blank"
							aria-label="RSS feed"
						>
							<Rss className="text-primary w-3" />
							<span className="hidden sm:inline">RSS</span>
						</Link>
					</Button>
				</div>
			</div>
			{view === 'graph' && hasGraph ? (
				<div className="h-[calc(100svh-var(--nav-height)-7rem)] w-full">
					<PostsGraph
						graph={graph!}
						enableZoom
						showHoverCard
						matchIds={debouncedMatchIds}
					/>
				</div>
			) : (
				<InfiniteHits />
			)}
		</>
	)
}

function Search({ graph }: { graph?: PostsGraphData }) {
	const [type, setType] = useQueryState('type')
	const [query, setQuery] = useQueryState('q')
	const [sort, setSort] = useQueryState('sort')
	// `view` lives here (parent) — NOT inside SearchContent — because nuqs has no
	// adapter context during InstantSearchNext's server-side getServerState pass,
	// and calling useQueryState there breaks the server render (Configure filter
	// is dropped → SSR leaks unfiltered results). See Algolia React SSR guide.
	const [viewParam, setViewParam] = useQueryState('view')
	const view: 'list' | 'graph' = viewParam === 'graph' ? 'graph' : 'list'
	const setView = (v: 'list' | 'graph') =>
		setViewParam(v === 'graph' ? 'graph' : null)

	const initialUiState = {
		[TYPESENSE_COLLECTION_NAME]: {
			query: query || '',
			sortBy: (sort && SORT_KEY_TO_VALUE[sort]) || DEFAULT_SORT_VALUE,
			configure: { filters: SEARCH_FILTER, hitsPerPage: 40 },
			refinementList: {
				...(typeof type === 'string' && {
					type: type.split(','),
				}),
			},
		},
	}

	return (
		<InstantSearchNext
			searchClient={typesenseInstantsearchAdapter.searchClient}
			indexName={TYPESENSE_COLLECTION_NAME}
			routing={false}
			onStateChange={({ uiState, setUiState }) => {
				try {
					function handleRefinementListChange(
						attribute: string,
						setState: (value: any) => void,
					) {
						const refinementList =
							uiState[TYPESENSE_COLLECTION_NAME]?.refinementList?.[attribute]
						if (refinementList && refinementList.length > 0) {
							setState(refinementList)
						} else {
							setState(null)
						}
					}

					const searchQuery = uiState[TYPESENSE_COLLECTION_NAME]?.query
					setQuery(searchQuery || null)

					handleRefinementListChange('type', setType)

					// Persist sort to the URL (default stays absent for clean links).
					const sortBy = uiState[TYPESENSE_COLLECTION_NAME]?.sortBy
					const sortKey = sortBy ? SORT_VALUE_TO_KEY[sortBy] : undefined
					setSort(sortKey && sortBy !== DEFAULT_SORT_VALUE ? sortKey : null)

					setUiState(uiState)
				} catch (error) {
					console.error('Search state update error:', error)
				}
			}}
			initialUiState={initialUiState}
			future={{ preserveSharedStateOnUnmount: true }}
		>
			<SearchContent graph={graph} view={view} setView={setView} />
		</InstantSearchNext>
	)
}
