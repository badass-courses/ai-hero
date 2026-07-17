import { NextRequest, NextResponse } from 'next/server'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { withSkill } from '@/server/with-skill'
import Typesense from 'typesense'
import { v4 as uuidv4 } from 'uuid'

const COLLECTION = 'support_memory'
const DECAY_RATE = 0.01 // exp(-0.01 * days) => 50% at ~70 days

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
	'Cache-Control': 'no-store, max-age=0',
}

export async function OPTIONS() {
	return NextResponse.json({}, { headers: corsHeaders })
}

function getClient() {
	const host = process.env.NEXT_PUBLIC_TYPESENSE_HOST
	const apiKey = process.env.TYPESENSE_WRITE_API_KEY
	if (!host || !apiKey) return null
	return new Typesense.Client({
		nodes: [{ host, port: 443, protocol: 'https' }],
		apiKey,
		connectionTimeoutSeconds: 5,
	})
}

/**
 * GET /api/memory?q=<query>&semantic=true&category=<cat>&per_page=5
 *
 * Recall support memory. Returns observations ranked by relevance
 * with time decay applied.
 */
const recallHandler = async (request: NextRequest) => {
	const { authMethod } = await getUserAbilityForRequest(request)
	if (authMethod === 'personal-access-token') {
		return NextResponse.json(
			{
				ok: false,
				command: 'memory recall',
				error: { message: 'Forbidden', code: 'FORBIDDEN' },
				fix: 'Use a credential with memory access.',
				next_actions: [],
			},
			{ status: 403, headers: corsHeaders },
		)
	}

	const { searchParams } = new URL(request.url)
	const q = searchParams.get('q')
	const category = searchParams.get('category')
	const perPage = Math.min(Number(searchParams.get('per_page') || '5'), 15)
	const semantic = searchParams.get('semantic') === 'true'

	if (!q) {
		return NextResponse.json(
			{
				ok: false,
				command: 'memory recall',
				error: { message: 'Missing q parameter', code: 'MISSING_QUERY' },
				fix: 'Add ?q=<query> to search support memory.',
				next_actions: [],
			},
			{ status: 400, headers: corsHeaders },
		)
	}

	const client = getClient()
	if (!client) {
		return NextResponse.json(
			{
				ok: false,
				command: 'memory recall',
				error: {
					message: 'Typesense not configured',
					code: 'SEARCH_UNAVAILABLE',
				},
				fix: 'Set NEXT_PUBLIC_TYPESENSE_HOST and TYPESENSE_WRITE_API_KEY.',
				next_actions: [],
			},
			{ status: 503, headers: corsHeaders },
		)
	}

	try {
		const filterParts = ['write_verdict:=allow', 'stale:=false']
		if (category) filterParts.push(`category:=${category}`)

		const results = await client
			.collections(COLLECTION)
			.documents()
			.search({
				q,
				query_by: semantic ? 'embedding,observation' : 'observation',
				exclude_fields: 'embedding',
				filter_by: filterParts.join(' && '),
				per_page: perPage * 2, // fetch extra, then rank with decay
				...(semantic && {
					vector_query: 'embedding:([], alpha: 0.6)',
					prefix: 'false' as unknown as boolean,
				}),
			})

		const now = Date.now() / 1000

		const ranked = (results.hits ?? [])
			.map((hit) => {
				const doc = hit.document as Record<string, unknown>
				const hitAny = hit as unknown as Record<string, unknown>
				const ts = (doc.timestamp as number) || now
				const daysSince = (now - ts) / 86400
				const rawScore =
					hitAny.hybrid_search_info != null
						? (hitAny.hybrid_search_info as { rank_fusion_score: number })
								.rank_fusion_score
						: hit.text_match_info?.score
							? Number(hit.text_match_info.score) / 1e15
							: 0.5

				const decayedScore = rawScore * Math.exp(-DECAY_RATE * daysSince)
				const vecDist = hitAny.vector_distance as number | undefined

				return {
					id: doc.id as string,
					observation: doc.observation as string,
					category: doc.category as string,
					observation_type: doc.observation_type as string,
					source: doc.source as string,
					timestamp: ts,
					days_ago: Math.round(daysSince),
					raw_score: rawScore,
					decayed_score: decayedScore,
					merged_count: doc.merged_count as number,
					...(vecDist != null && { vector_distance: vecDist }),
				}
			})
			.sort((a, b) => b.decayed_score - a.decayed_score)
			.slice(0, perPage)

		return NextResponse.json(
			{
				ok: true,
				command: `memory recall "${q}"`,
				result: {
					query: q,
					mode: semantic ? 'hybrid' : 'keyword',
					found: results.found,
					returned: ranked.length,
					observations: ranked,
				},
				next_actions: [
					{
						command: `/api/memory?q=<query>&semantic=true&category=<category>`,
						description: 'Refine memory search',
						params: {
							query: { value: q, required: true as const },
							category: {
								enum: [
									'product-fact',
									'resolution-pattern',
									'customer-context',
									'tool-gotcha',
									'voice-rule',
									'process',
								],
							},
						},
					},
					{
						command: '/api/memory',
						description: 'Store a new observation (POST)',
					},
				],
			},
			{ headers: corsHeaders },
		)
	} catch (error) {
		return NextResponse.json(
			{
				ok: false,
				command: `memory recall "${q}"`,
				error: {
					message: 'Recall failed',
					code: 'RECALL_ERROR',
				},
				fix:
					error instanceof Error
						? `Typesense error: ${error.message}`
						: 'Check Typesense configuration.',
				next_actions: [],
			},
			{ status: 500, headers: corsHeaders },
		)
	}
}

/**
 * POST /api/memory
 *
 * Store a new support memory observation.
 * Body: { observation, category, source?, observation_type?, write_verdict?, confidence? }
 *
 * Deduplicates: if a semantically similar observation exists (vector distance < 0.15),
 * increments merged_count on the existing doc instead of inserting.
 */
const storeHandler = async (request: NextRequest) => {
	const { authMethod, user } = await getUserAbilityForRequest(request)
	if (authMethod === 'personal-access-token') {
		return NextResponse.json(
			{
				ok: false,
				command: 'memory store',
				error: { message: 'Forbidden', code: 'FORBIDDEN' },
				fix: 'Use a credential with memory write access.',
				next_actions: [],
			},
			{ status: 403, headers: corsHeaders },
		)
	}

	if (!user) {
		return NextResponse.json(
			{
				ok: false,
				command: 'memory store',
				error: { message: 'Unauthorized', code: 'UNAUTHORIZED' },
				fix: 'Authenticate with a valid device token.',
				next_actions: [],
			},
			{ status: 401, headers: corsHeaders },
		)
	}

	const client = getClient()
	if (!client) {
		return NextResponse.json(
			{
				ok: false,
				command: 'memory store',
				error: {
					message: 'Typesense not configured',
					code: 'SEARCH_UNAVAILABLE',
				},
				fix: 'Set NEXT_PUBLIC_TYPESENSE_HOST and TYPESENSE_WRITE_API_KEY.',
				next_actions: [],
			},
			{ status: 503, headers: corsHeaders },
		)
	}

	try {
		const body = await request.json()
		const {
			observation,
			category,
			source = 'manual',
			observation_type = 'fact',
			write_verdict = 'allow',
			confidence = 0.9,
		} = body

		if (!observation || !category) {
			return NextResponse.json(
				{
					ok: false,
					command: 'memory store',
					error: {
						message: 'Missing observation or category',
						code: 'INVALID_INPUT',
					},
					fix: 'Provide both "observation" (string) and "category" (product-fact|resolution-pattern|customer-context|tool-gotcha|voice-rule|process).',
					next_actions: [],
				},
				{ status: 400, headers: corsHeaders },
			)
		}

		// Dedup check: search for semantically similar existing observations
		let dedupResult: { action: string; existingId?: string } = {
			action: 'insert',
		}

		try {
			const similar = await client
				.collections(COLLECTION)
				.documents()
				.search({
					q: observation,
					query_by: 'embedding',
					exclude_fields: 'embedding',
					per_page: 1,
					prefix: 'false' as unknown as boolean,
				})

			const topHit = similar.hits?.[0]
			const topHitAny = topHit as unknown as Record<string, unknown> | undefined
			const topVecDist = topHitAny?.vector_distance as number | undefined
			if (topHit && topVecDist != null && topVecDist < 0.15) {
				const existingDoc = topHit.document as Record<string, unknown>
				const existingId = existingDoc.id as string
				const existingCount = (existingDoc.merged_count as number) || 1

				// Merge: update existing doc
				await client
					.collections(COLLECTION)
					.documents(existingId)
					.update({
						merged_count: existingCount + 1,
						timestamp: Math.floor(Date.now() / 1000),
					})

				dedupResult = { action: 'merged', existingId }
			}
		} catch {
			// Dedup check failed, proceed with insert
		}

		if (dedupResult.action === 'insert') {
			const id = uuidv4()
			await client
				.collections(COLLECTION)
				.documents()
				.create({
					id,
					observation,
					observation_type,
					category,
					source,
					timestamp: Math.floor(Date.now() / 1000),
					write_verdict,
					confidence,
					merged_count: 1,
					recall_count: 0,
					stale: false,
				})
			dedupResult = { action: 'created', existingId: id }
		}

		return NextResponse.json(
			{
				ok: true,
				command: 'memory store',
				result: {
					...dedupResult,
					observation:
						observation.slice(0, 100) + (observation.length > 100 ? '...' : ''),
					category,
				},
				next_actions: [
					{
						command: `/api/memory?q=${encodeURIComponent(observation.slice(0, 50))}`,
						description: 'Verify the stored observation',
					},
					{
						command: '/api/memory',
						description: 'Store another observation (POST)',
					},
				],
			},
			{ headers: corsHeaders },
		)
	} catch (error) {
		return NextResponse.json(
			{
				ok: false,
				command: 'memory store',
				error: {
					message: 'Store failed',
					code: 'STORE_ERROR',
				},
				fix:
					error instanceof Error
						? `Error: ${error.message}`
						: 'Check request body and Typesense configuration.',
				next_actions: [],
			},
			{ status: 500, headers: corsHeaders },
		)
	}
}

export const GET = withSkill(recallHandler)
export const POST = withSkill(storeHandler)
