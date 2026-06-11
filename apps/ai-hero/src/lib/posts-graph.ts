'use server'

import { log } from '@/server/logger'
import { unstable_cache } from 'next/cache'
import Typesense from 'typesense'
import type { MultiSearchRequestSchema } from 'typesense/lib/Typesense/MultiSearch'

import { getTypesenseCollectionName } from '@coursebuilder/utils/typesense-adapter'

const TYPESENSE_COLLECTION_NAME = getTypesenseCollectionName({
	envVar: 'NEXT_PUBLIC_TYPESENSE_COLLECTION_NAME',
	defaultValue: 'content_production',
})

// Mirror the search universe: everything published + public except dictionary
// entries. Docs without an embedding simply can't be placed and drop out.
const GRAPH_FILTER = `state:=published && visibility:=public && type:!=[dictionary,dictionary-entry]`

export type PostsGraphNode = {
	id: string
	title: string
	slug: string
	type: string
	/** node size driver — popularity, falls back to degree at render time */
	val: number
	tags: string[]
	/** for the hover preview card */
	summary?: string
	image?: string
}

export type PostsGraphEdge = {
	source: string
	target: string
	/** 0..1, higher = more similar (1 - vector_distance) */
	weight: number
}

export type PostsGraph = {
	nodes: PostsGraphNode[]
	edges: PostsGraphEdge[]
	generatedAt: number
	/** set for local (per-post) graphs — the post being viewed */
	centerId?: string
}

type GraphBuildOptions = {
	/** nearest neighbors to request per node before pruning */
	k?: number
	/** drop neighbors whose vector_distance exceeds this (0..2 for cosine) */
	distanceThreshold?: number
}

function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}

function edgeKey(a: string, b: string) {
	return a < b ? `${a}|${b}` : `${b}|${a}`
}

function createTypesenseClient() {
	if (
		!process.env.TYPESENSE_WRITE_API_KEY ||
		!process.env.NEXT_PUBLIC_TYPESENSE_HOST
	) {
		return null
	}
	return new Typesense.Client({
		nodes: [
			{
				host: process.env.NEXT_PUBLIC_TYPESENSE_HOST!,
				port: 443,
				protocol: 'https',
			},
		],
		apiKey: process.env.TYPESENSE_WRITE_API_KEY!,
		connectionTimeoutSeconds: 10,
	})
}

function toNode(doc: any): PostsGraphNode {
	const summary =
		typeof doc.summary === 'string' && doc.summary.length > 0
			? doc.summary
			: typeof doc.description === 'string'
				? doc.description
				: undefined
	return {
		id: doc.id,
		title: doc.title ?? 'Untitled',
		slug: doc.slug ?? doc.id,
		type: doc.type ?? 'post',
		val: doc.popularity_30d ?? 1,
		tags: extractTagLabels(doc),
		summary,
		image: typeof doc.image === 'string' ? doc.image : undefined,
	}
}

function extractTagLabels(doc: any): string[] {
	const tags = doc?.tags
	if (!Array.isArray(tags)) return []
	return tags
		.map((t: any) => t?.fields?.label ?? t?.fields?.name ?? t?.label)
		.filter((label: unknown): label is string => typeof label === 'string')
}

/**
 * Builds a semantic similarity graph for published posts/lists/articles by
 * running a kNN vector query per document against the Typesense `embedding`
 * field, then deduping the resulting edges. Expensive — cache the result.
 */
export async function buildPostsGraph({
	k = 6,
	distanceThreshold = 0.35,
}: GraphBuildOptions = {}): Promise<PostsGraph> {
	const client = createTypesenseClient()
	if (!client) {
		void log.warn('posts-graph.config-missing', {})
		return { nodes: [], edges: [], generatedAt: Date.now() }
	}

	// 1. Pull every published node WITH its embedding via the export stream.
	//    Excluding nothing here because we need the vectors to query neighbors.
	let docs: any[] = []
	try {
		const jsonl = await client
			.collections(TYPESENSE_COLLECTION_NAME)
			.documents()
			.export({ filter_by: GRAPH_FILTER })

		docs = jsonl
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.filter((d) => Array.isArray(d.embedding) && d.embedding.length > 0)
	} catch (e) {
		void log.error('posts-graph.export.error', { error: getErrorMessage(e) })
		return { nodes: [], edges: [], generatedAt: Date.now() }
	}

	const nodes: PostsGraphNode[] = docs.map((d) => ({
		id: d.id,
		title: d.title ?? 'Untitled',
		slug: d.slug ?? d.id,
		type: d.type ?? 'post',
		val: d.popularity_30d ?? 1,
		tags: extractTagLabels(d),
	}))
	const validIds = new Set(nodes.map((n) => n.id))

	// 2. kNN per node, in batches via multiSearch (one search per doc).
	const edges = new Map<string, PostsGraphEdge>()
	const BATCH = 20

	for (let i = 0; i < docs.length; i += BATCH) {
		const batch = docs.slice(i, i + BATCH)
		const searchRequests: { searches: MultiSearchRequestSchema[] } = {
			searches: batch.map((doc) => ({
				collection: TYPESENSE_COLLECTION_NAME,
				q: '*',
				vector_query: `embedding:([${doc.embedding.join(', ')}], k:${k + 1}, distance_threshold: ${distanceThreshold})`,
				exclude_fields: 'embedding',
				include_fields: 'id',
				filter_by: `${GRAPH_FILTER} && id:!=${doc.id}`,
				per_page: k + 1,
			})),
		}

		try {
			const { results } = await client.multiSearch.perform(searchRequests, {})
			results.forEach((result: any, idx: number) => {
				const sourceId = batch[idx]?.id
				if (!sourceId) return
				for (const hit of result?.hits ?? []) {
					const targetId = hit?.document?.id
					if (!targetId || !validIds.has(targetId)) continue
					if (targetId === sourceId) continue
					const distance =
						typeof hit.vector_distance === 'number' ? hit.vector_distance : 1
					const key = edgeKey(sourceId, targetId)
					const weight = Math.max(0, 1 - distance)
					const existing = edges.get(key)
					if (!existing || weight > existing.weight) {
						edges.set(key, { source: sourceId, target: targetId, weight })
					}
				}
			})
		} catch (e) {
			void log.error('posts-graph.knn.batch-error', {
				batchStart: i,
				error: getErrorMessage(e),
			})
		}
	}

	const graph: PostsGraph = {
		nodes,
		edges: Array.from(edges.values()),
		generatedAt: Date.now(),
	}

	void log.info('posts-graph.built', {
		nodeCount: graph.nodes.length,
		edgeCount: graph.edges.length,
		k,
		distanceThreshold,
	})

	return graph
}

/**
 * Builds a small "local" graph centered on one post: the post itself plus its
 * `k` nearest neighbors, with edges from the center to each neighbor and any
 * neighbor↔neighbor edges discovered along the way. Mirrors Quartz's depth:1
 * local graph. Cheap enough to compute per page (still cache it).
 */
export async function buildLocalPostGraph(
	documentId: string,
	{ k = 8, distanceThreshold = 0.4 }: GraphBuildOptions = {},
): Promise<PostsGraph> {
	const client = createTypesenseClient()
	if (!client) {
		void log.warn('posts-graph.local.config-missing', { documentId })
		return { nodes: [], edges: [], generatedAt: Date.now() }
	}

	let center: any
	try {
		center = await client
			.collections(TYPESENSE_COLLECTION_NAME)
			.documents(documentId)
			.retrieve()
	} catch (e) {
		void log.error('posts-graph.local.center-not-found', {
			documentId,
			error: getErrorMessage(e),
		})
		return { nodes: [], edges: [], generatedAt: Date.now() }
	}

	if (!Array.isArray(center?.embedding) || center.embedding.length === 0) {
		return {
			nodes: [],
			edges: [],
			generatedAt: Date.now(),
			centerId: documentId,
		}
	}

	// 1. center → k neighbors (keep embeddings so we can find inter-neighbor edges)
	let neighbors: any[] = []
	try {
		const { results } = await client.multiSearch.perform(
			{
				searches: [
					{
						collection: TYPESENSE_COLLECTION_NAME,
						q: '*',
						vector_query: `embedding:([${center.embedding.join(', ')}], k:${k + 1}, distance_threshold: ${distanceThreshold})`,
						filter_by: `${GRAPH_FILTER} && id:!=${documentId}`,
						per_page: k + 1,
					} as MultiSearchRequestSchema,
				],
			},
			{},
		)
		neighbors = (results?.[0] as any)?.hits ?? []
	} catch (e) {
		void log.error('posts-graph.local.knn-error', {
			documentId,
			error: getErrorMessage(e),
		})
	}

	const nodes: PostsGraphNode[] = [toNode(center)]
	const edges = new Map<string, PostsGraphEdge>()
	const neighborDocs: any[] = []

	for (const hit of neighbors) {
		const doc = hit?.document
		if (!doc?.id || doc.id === documentId) continue
		neighborDocs.push(doc)
		nodes.push(toNode(doc))
		const distance =
			typeof hit.vector_distance === 'number' ? hit.vector_distance : 1
		edges.set(edgeKey(documentId, doc.id), {
			source: documentId,
			target: doc.id,
			weight: Math.max(0, 1 - distance),
		})
	}

	// 2. neighbor ↔ neighbor edges (so clusters read as clusters, not a star)
	const neighborIds = new Set(neighborDocs.map((d) => d.id))
	const withEmbeddings = neighborDocs.filter(
		(d) => Array.isArray(d.embedding) && d.embedding.length > 0,
	)
	if (withEmbeddings.length > 0) {
		try {
			const { results } = await client.multiSearch.perform(
				{
					searches: withEmbeddings.map(
						(d) =>
							({
								collection: TYPESENSE_COLLECTION_NAME,
								q: '*',
								vector_query: `embedding:([${d.embedding.join(', ')}], k:5, distance_threshold: ${distanceThreshold})`,
								exclude_fields: 'embedding',
								include_fields: 'id',
								filter_by: `${GRAPH_FILTER} && id:!=${d.id}`,
								per_page: 5,
							}) as MultiSearchRequestSchema,
					),
				},
				{},
			)
			results.forEach((result: any, idx: number) => {
				const sourceId = withEmbeddings[idx]?.id
				if (!sourceId) return
				for (const hit of result?.hits ?? []) {
					const targetId = hit?.document?.id
					// only keep edges between nodes already in this local graph
					if (!targetId || !neighborIds.has(targetId)) continue
					if (targetId === sourceId) continue
					const key = edgeKey(sourceId, targetId)
					if (edges.has(key)) continue
					const distance =
						typeof hit.vector_distance === 'number' ? hit.vector_distance : 1
					edges.set(key, {
						source: sourceId,
						target: targetId,
						weight: Math.max(0, 1 - distance),
					})
				}
			})
		} catch (e) {
			void log.error('posts-graph.local.inter-neighbor-error', {
				documentId,
				error: getErrorMessage(e),
			})
		}
	}

	return {
		nodes,
		edges: Array.from(edges.values()),
		generatedAt: Date.now(),
		centerId: documentId,
	}
}

export async function getCachedLocalPostGraph(
	documentId: string,
): Promise<PostsGraph> {
	const cached = unstable_cache(
		() => buildLocalPostGraph(documentId),
		['posts-graph-local-v1', documentId],
		{
			revalidate: 60 * 60,
			tags: ['posts-graph', `posts-graph-local-${documentId}`],
		},
	)
	return cached()
}

const POSTS_GRAPH_CACHE_SECONDS = 60 * 60 // 1h; revalidate on post mutations via tag

const getCachedPostsGraphInternal = unstable_cache(
	() => buildPostsGraph(),
	['posts-graph-v2'],
	{
		revalidate: POSTS_GRAPH_CACHE_SECONDS,
		tags: ['posts-graph'],
	},
)

/** Cached entry point for the posts page. Revalidate with `revalidateTag('posts-graph')`. */
export async function getCachedPostsGraph(): Promise<PostsGraph> {
	return getCachedPostsGraphInternal()
}
