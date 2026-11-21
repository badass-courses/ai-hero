/**
 * Query parameters for typed searches on /q and the videos page.
 *
 * Keyword only. The collection's `embedding` field embeds the query through a
 * provider, and that provider has been failing, so any query_by that included
 * `embedding` returned an error instead of results (2026-11-21). Vectors come
 * back once they're computed off the shared cluster.
 *
 * `prefix` needs one value per `query_by` field, or Typesense rejects the
 * search.
 */
export const KEYWORD_QUERY_PARAMS = {
	query_by: 'title,description,summary',
	prefix: 'true,true,true',
} as const
