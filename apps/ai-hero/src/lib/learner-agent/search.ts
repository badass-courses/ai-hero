import { getAbility } from '@/ability'
import { buildTypesenseContentFilter } from '@/lib/typesense-content-filter'
import { getResourcePath } from '@/utils/resource-paths'
import Typesense from 'typesense'

import type { PublicSearchHit, SearchPort } from '@ai-hero/learner-agent'

/**
 * Public search, the same index and filter `/api/search` uses for an
 * anonymous caller: published, public content only. The package marks which
 * hits the learner can read; this port never widens the filter.
 */
export function makeSearchPort({ baseUrl }: { baseUrl: string }): SearchPort {
	return {
		search: async ({ text, limit }) => {
			const host = process.env.NEXT_PUBLIC_TYPESENSE_HOST
			const apiKey = process.env.TYPESENSE_WRITE_API_KEY
			if (!host || !apiKey) throw new Error('Typesense is not configured')
			const collectionName =
				process.env.TYPESENSE_COLLECTION_NAME ||
				process.env.NEXT_PUBLIC_TYPESENSE_COLLECTION_NAME ||
				'content_production'

			const client = new Typesense.Client({
				nodes: [{ host, port: 443, protocol: 'https' }],
				apiKey,
				connectionTimeoutSeconds: 5,
			})
			const filterBy = buildTypesenseContentFilter({ ability: getAbility() })
			const results = await client
				.collections(collectionName)
				.documents()
				.search({
					q: text,
					query_by: 'title,summary,description',
					exclude_fields: 'embedding,description',
					...(filterBy && { filter_by: filterBy }),
					per_page: limit,
				})

			return (results.hits ?? []).flatMap((hit): PublicSearchHit[] => {
				const doc = hit.document as Record<string, unknown>
				const id = typeof doc.id === 'string' ? doc.id : null
				const type = typeof doc.type === 'string' ? doc.type : ''
				const slug = typeof doc.slug === 'string' ? doc.slug : ''
				const title = typeof doc.title === 'string' ? doc.title : ''
				if (!id || !title) return []
				return [
					{
						id,
						type,
						title,
						url: `${baseUrl}${getResourcePath(type, slug, 'view')}`,
						summary: typeof doc.summary === 'string' ? doc.summary : '',
					},
				]
			})
		},
	}
}
