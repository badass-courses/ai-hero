import { NextRequest, NextResponse } from 'next/server'
import { withSkill } from '@/server/with-skill'
import Typesense from 'typesense'

import { getResourcePath } from '@coursebuilder/utils/resource-paths'
import type {
	SearchParams,
	SearchResponseHit,
} from 'typesense/lib/Typesense/Documents'

/**
 * Typesense returns these fields for vector/hybrid searches but they're
 * not in the published type definitions yet.
 */
interface VectorSearchHit<
	T extends Record<string, unknown>,
> extends SearchResponseHit<T> {
	vector_distance?: number
	hybrid_search_info?: { rank_fusion_score: number }
}

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
	'Cache-Control': 'no-store, max-age=0',
}

export async function OPTIONS() {
	return NextResponse.json({}, { headers: corsHeaders })
}

function buildUrl(baseUrl: string, docType: string, slug: string): string {
	return `${baseUrl}${getResourcePath(docType, slug, 'view')}`
}

function isDictionaryHit(type: string) {
	return type === 'dictionary' || type === 'dictionary-entry'
}

/**
 * GET /api/search?q=<query>&type=<type>&per_page=5&semantic=true
 *
 * Search AI Hero content via Typesense. Returns an agent-friendly
 * HATEOAS JSON envelope with hits and next_actions.
 *
 * Supports two modes:
 *   - keyword (default): text search across title, summary, description
 *   - hybrid (semantic=true): keyword + vector similarity via OpenAI embeddings
 *
 * Params:
 *   q          - Search query, natural language or keywords (required)
 *   type       - Filter by content type: lesson, workshop, article, cohort, post, tutorial, event
 *   per_page   - Results per page (default 5, max 20)
 *   semantic   - Enable hybrid semantic + keyword search (default false)
 */
const searchHandler = async (request: NextRequest) => {
	const { searchParams } = new URL(request.url)
	const q = searchParams.get('q')
	const type = searchParams.get('type')
	const perPage = Math.min(Number(searchParams.get('per_page') || '5'), 20)
	const semantic = searchParams.get('semantic') === 'true'

	if (!q) {
		return NextResponse.json(
			{
				ok: false,
				command: 'search',
				error: { message: 'Missing q parameter', code: 'MISSING_QUERY' },
				fix: 'Add a ?q=<query> parameter to search for content.',
				next_actions: [
					{
						command: '/api/search?q=<query>',
						description: 'Search content',
						params: {
							query: {
								description: 'Search query (natural language or keywords)',
								required: true,
							},
						},
					},
				],
			},
			{ status: 400, headers: corsHeaders },
		)
	}

	const host = process.env.NEXT_PUBLIC_TYPESENSE_HOST
	const apiKey = process.env.TYPESENSE_WRITE_API_KEY
	const collectionName =
		process.env.TYPESENSE_COLLECTION_NAME ||
		process.env.NEXT_PUBLIC_TYPESENSE_COLLECTION_NAME ||
		'content_production'

	if (!host || !apiKey) {
		return NextResponse.json(
			{
				ok: false,
				command: 'search',
				error: {
					message: 'Typesense not configured',
					code: 'SEARCH_UNAVAILABLE',
				},
				fix: 'Set NEXT_PUBLIC_TYPESENSE_HOST and TYPESENSE_WRITE_API_KEY environment variables.',
				next_actions: [],
			},
			{ status: 503, headers: corsHeaders },
		)
	}

	try {
		const client = new Typesense.Client({
			nodes: [{ host, port: 443, protocol: 'https' }],
			apiKey,
			connectionTimeoutSeconds: 5,
		})

		const filterParts = ['state:=published']
		if (type) {
			filterParts.push(`type:=${type}`)
		}

		const searchParameters: SearchParams = {
			q,
			query_by: semantic
				? 'embedding,title,summary,description'
				: 'title,summary,description',
			exclude_fields: 'embedding,description',
			filter_by: filterParts.join(' && '),
			per_page: perPage,
			...(semantic && {
				vector_query: 'embedding:([], alpha: 0.5)',
				prefix: 'false' as unknown as boolean,
			}),
		}

		const results = await client
			.collections(collectionName)
			.documents()
			.search(searchParameters)

		const baseUrl = process.env.NEXT_PUBLIC_URL || 'https://www.aihero.dev'

		const hits = (results.hits ?? []).map((_hit) => {
			const hit = _hit as VectorSearchHit<Record<string, unknown>>
			const doc = hit.document as Record<string, unknown>
			const slug = (doc.slug as string) || ''
			const docType = (doc.type as string) || ''
			const url = buildUrl(baseUrl, docType, slug)

			return {
				id: doc.id as string,
				type: docType,
				title: doc.title as string,
				slug,
				url,
				summary: (doc.summary as string) || '',
				...(hit.vector_distance != null && {
					vector_distance: hit.vector_distance,
				}),
				...(hit.hybrid_search_info != null && {
					rank_fusion_score: hit.hybrid_search_info.rank_fusion_score,
				}),
			}
		})

		const nextActions = [
			// Suggest fetching full resource for CourseBuilder resources, or opening canonical URLs for dictionary hits
			...hits.slice(0, 3).map((h) =>
				isDictionaryHit(h.type)
					? {
							command: h.url,
							description: `Open dictionary page: ${h.title}`,
						}
					: {
							command: `/api/resources?slugOrId=${h.slug}&type=${h.type}`,
							description: `Fetch full resource: ${h.title}`,
						},
			),
			// Suggest refining the search
			{
				command: `/api/search?q=<query>&type=<type>&per_page=<n>&semantic=<bool>`,
				description: 'Refine search',
				params: {
					query: {
						value: q,
						description: 'Search query',
						required: true as const,
					},
					type: {
						description: 'Content type filter',
						enum: [
							'lesson',
							'workshop',
							'article',
							'cohort',
							'post',
							'tutorial',
							'event',
							'dictionary',
							'dictionary-entry',
						],
					},
					n: { default: 5, description: 'Results per page (max 20)' },
					bool: {
						value: String(semantic),
						enum: ['true', 'false'],
						description: 'Hybrid semantic + keyword search',
					},
				},
			},
		]

		return NextResponse.json(
			{
				ok: true,
				command: `search "${q}"`,
				result: {
					query: q,
					found: results.found,
					search_time_ms: results.search_time_ms,
					mode: semantic ? 'hybrid' : 'keyword',
					hits,
				},
				next_actions: nextActions,
			},
			{ headers: corsHeaders },
		)
	} catch (error) {
		return NextResponse.json(
			{
				ok: false,
				command: `search "${q}"`,
				error: {
					message: 'Search failed',
					code: 'SEARCH_ERROR',
				},
				fix:
					error instanceof Error
						? `Typesense error: ${error.message}`
						: 'Check Typesense configuration and connectivity.',
				next_actions: [
					{
						command: `/api/search?q=${encodeURIComponent(q)}`,
						description: 'Retry this search',
					},
				],
			},
			{ status: 500, headers: corsHeaders },
		)
	}
}

export const GET = withSkill(searchHandler)
