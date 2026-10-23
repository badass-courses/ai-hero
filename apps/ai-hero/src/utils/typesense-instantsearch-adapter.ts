// Import directly from typesense-instantsearch-adapter
import TypesenseInstantSearchAdapter from 'typesense-instantsearch-adapter'

import {
	createDefaultConfig,
	getTypesenseCollectionName,
} from '@coursebuilder/utils/typesense-adapter'
import { env } from '@/env.mjs'

// App-specific configuration
const config = createDefaultConfig({
	apiKey: process.env.NEXT_PUBLIC_TYPESENSE_API_KEY ?? '',
	host: process.env.NEXT_PUBLIC_TYPESENSE_HOST ?? 'test',
	port: Number(process.env.NEXT_PUBLIC_TYPESENSE_PORT) ?? 8108,
	// Keyword fields only by default. Hybrid (semantic) search adds the
	// `embedding` field to query_by *dynamically* — but only when there is a
	// non-empty query, because embedding an empty string errors at the provider.
	// See the dynamic <Configure> in search.tsx.
	queryBy: 'title,description,summary',
	preset: 'updated_at_timestamp',
	sortBy: '_text_match:desc', // default sort
})

// Never ship the embedding vectors to the client.
//
// Nor `description`: it is the full post body, and the hit UI renders only
// `title` and `summary`. Returning it put each body in the response FOUR times
// (the document, `_highlightResult`, `_snippetResult`, `_rawTypesenseHit`) —
// 1.6MB of the 2MB `/posts` HTML was the 40 server-rendered hits. It stays in
// `query_by`, so search still matches on it.
config.additionalSearchParameters.exclude_fields = 'embedding,description'
// Highlight only what is rendered. The adapter's default is every `query_by`
// field, which asked Typesense for a full-text highlight of each body too.
// `summary` stays in `highlight_full_fields` on purpose: `<Highlight>` reads
// the full highlighted value, and without it a matched summary would render
// as a 30-word snippet.
config.additionalSearchParameters.highlight_fields = 'title,summary'
config.additionalSearchParameters.highlight_full_fields = 'title,summary'

// Create adapter directly instead of using the createTypesenseAdapter function
export const typesenseInstantsearchAdapter = new TypesenseInstantSearchAdapter(
	config,
)

export const TYPESENSE_COLLECTION_NAME = process.env.NEXT_PUBLIC_TYPESENSE_COLLECTION_NAME ||getTypesenseCollectionName({
	envVar: 'NEXT_PUBLIC_TYPESENSE_COLLECTION_NAME',
	defaultValue: 'content_production',
})

// For backward compatibility
export const typsenseAdapterConfig = config
