import { NextRequest, NextResponse } from 'next/server'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'
import {
	redactCustomerIdentifiers,
	REFUSED_MEMORY_CATEGORIES,
} from '@/lib/support-memory-redact'
import Typesense from 'typesense'
import { v4 as uuidv4 } from 'uuid'

const COLLECTION = 'support_memory'
const DECAY_RATE = 0.01 // exp(-0.01 * days) => 50% at ~70 days

// No Access-Control-Allow-Origin: this store holds private support context, so
// no other origin may read it from a browser (security desk, 2026-11-21).
const corsHeaders = {
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
 * Support memory is private operator context and can hold customer details,
 * so both recall and store need an admin device token. Anonymous callers,
 * personal access tokens and narrower device scopes are refused
 * (security desk, 2026-11-21: GET used to answer anyone).
 */
async function refuseUnlessMemoryAdmin(
	request: NextRequest,
	command: 'memory recall' | 'memory store',
) {
	const { authMethod, user, ability } = await getUserAbilityForRequest(request)
	if (authMethod === 'personal-access-token') {
		return NextResponse.json(
			{
				ok: false,
				command,
				error: { message: 'Forbidden', code: 'FORBIDDEN' },
				fix: 'Use a credential with memory access.',
				docs: '/api',
				next_actions: [],
			},
			{ status: 403, headers: corsHeaders },
		)
	}
	if (!user) {
		return NextResponse.json(
			{
				ok: false,
				command,
				error: { message: 'Unauthorized', code: 'UNAUTHORIZED' },
				fix: 'Authenticate with an admin device token.',
				docs: '/api',
				next_actions: [],
			},
			{ status: 401, headers: corsHeaders },
		)
	}
	if (!ability.can('manage', 'all')) {
		return NextResponse.json(
			{
				ok: false,
				command,
				error: { message: 'Forbidden', code: 'FORBIDDEN' },
				fix: 'Support memory needs an admin credential.',
				docs: '/api',
				next_actions: [],
			},
			{ status: 403, headers: corsHeaders },
		)
	}
	return null
}

/**
 * GET /api/memory?q=<query>&semantic=true&category=<cat>&per_page=5
 *
 * Recall support memory. Returns observations ranked by relevance
 * with time decay applied.
 */
const recallHandler = async (request: NextRequest) => {
	const refused = await refuseUnlessMemoryAdmin(request, 'memory recall')
	if (refused) return refused

	const { searchParams } = new URL(request.url)
	const q = searchParams.get('q')
	const category = searchParams.get('category')
	const perPage = Math.min(Number(searchParams.get('per_page') || '5'), 15)
	// `semantic` is accepted for old callers and ignored: support_memory has no
	// embedding field since the 2026-11-21 cluster OOM, so recall is keyword.

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
				query_by: 'observation',
				filter_by: filterParts.join(' && '),
				per_page: perPage * 2, // fetch extra, then rank with decay
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
					mode: 'keyword',
					found: results.found,
					returned: ranked.length,
					observations: ranked,
				},
				next_actions: [
					{
						command: `/api/memory?q=<query>&category=<category>`,
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
		await log.error('memory.recall.failed', {
			error: error instanceof Error ? error.message : String(error),
		})
		return NextResponse.json(
			{
				ok: false,
				command: `memory recall "${q}"`,
				error: {
					message: 'Recall failed',
					code: 'RECALL_ERROR',
				},
				fix: 'Check Typesense configuration.',
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
 * Customer emails and Front conversation and message ids are redacted from
 * `observation` and `source`, and `customer-context` notes are refused
 * (sec-032 follow-up). No vector dedup: the collection has no embedding
 * field, so every store inserts.
 */
const storeHandler = async (request: NextRequest) => {
	const refused = await refuseUnlessMemoryAdmin(request, 'memory store')
	if (refused) return refused

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
			observation: rawObservation,
			category,
			source: rawSource = 'manual',
			observation_type = 'fact',
			write_verdict = 'allow',
			confidence = 0.9,
		} = body

		if ((REFUSED_MEMORY_CATEGORIES as readonly string[]).includes(category)) {
			return NextResponse.json(
				{
					ok: false,
					command: 'memory store',
					error: {
						message: 'customer-context notes are not stored',
						code: 'CATEGORY_REFUSED',
					},
					fix: 'Store the reusable lesson under another category, without naming the customer.',
					next_actions: [],
				},
				{ status: 422, headers: corsHeaders },
			)
		}

		if (typeof rawObservation !== 'string' || !rawObservation || !category) {
			return NextResponse.json(
				{
					ok: false,
					command: 'memory store',
					error: {
						message: 'Missing observation or category',
						code: 'INVALID_INPUT',
					},
					fix: 'Provide both "observation" (string) and "category" (product-fact|resolution-pattern|tool-gotcha|voice-rule|process).',
					next_actions: [],
				},
				{ status: 400, headers: corsHeaders },
			)
		}

		const observation = redactCustomerIdentifiers(rawObservation).text
		const source = redactCustomerIdentifiers(String(rawSource)).text

		let dedupResult: { action: string; existingId?: string } = {
			action: 'insert',
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
		await log.error('memory.store.failed', {
			error: error instanceof Error ? error.message : String(error),
		})
		return NextResponse.json(
			{
				ok: false,
				command: 'memory store',
				error: {
					message: 'Store failed',
					code: 'STORE_ERROR',
				},
				fix: 'Check request body and Typesense configuration.',
				next_actions: [],
			},
			{ status: 500, headers: corsHeaders },
		)
	}
}

export const GET = withSkill(recallHandler)
export const POST = withSkill(storeHandler)
