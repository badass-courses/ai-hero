import { TYPESENSE_COLLECTION_NAME } from '@/utils/typesense-instantsearch-adapter'

// Newest/Oldest sort by created_at (publish date) — the date shown on each card
// (hit.tsx renders created_at_timestamp). Sorting by updated_at instead would
// float recently-edited old posts to the top, contradicting their visible date.
export const NEWEST_SORT_VALUE = `${TYPESENSE_COLLECTION_NAME}/sort/_text_match(buckets:10):desc,created_at_timestamp:desc`
export const MOST_POPULAR_SORT_VALUE = `${TYPESENSE_COLLECTION_NAME}/sort/_text_match(buckets:10):desc,popularity_30d:desc`
export const RELEVANCE_SORT_VALUE = TYPESENSE_COLLECTION_NAME
export const OLDEST_SORT_VALUE = `${TYPESENSE_COLLECTION_NAME}/sort/_text_match(buckets:10):desc,created_at_timestamp:asc`

export const DEFAULT_SORT_VALUE = NEWEST_SORT_VALUE

// Every option except Relevance applies the bucketed text-match pattern from
// the Typesense ranking docs: results bucket into 10 relevance tiers and the
// secondary key orders within each tier. With q='*' (no query), every doc
// shares _text_match=0, so the secondary key dominates — meaning each sort
// behaves like its "pure" form when browsing, and stays relevance-aware when
// searching. Relevance itself stays granular (no buckets) for the rare
// "give me the rawest possible match ranking" use case.
export const sortOptions = [
	{
		value: NEWEST_SORT_VALUE,
		label: 'Newest first',
	},
	{
		value: MOST_POPULAR_SORT_VALUE,
		label: 'Most Popular',
	},
	{
		value: RELEVANCE_SORT_VALUE,
		label: 'Relevance',
	},
	{
		value: OLDEST_SORT_VALUE,
		label: 'Oldest first',
	},
]
