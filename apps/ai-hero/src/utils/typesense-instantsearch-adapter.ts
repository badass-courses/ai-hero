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
config.additionalSearchParameters.exclude_fields = 'embedding'

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
