import type { Client as TypesenseClient } from 'typesense'

import type { VideoFacts, VideoGraph } from './video-facts'

export const VIDEO_FACT_FIELDS = [
	'has_video',
	'free',
	'course_ids',
	'duration_seconds',
	'container_title',
	'mux_playback_id',
	'thumbnail_time',
] as const satisfies ReadonlyArray<keyof VideoFacts>

type IndexedVideoFacts = {
	id: string
	type?: string
	visibility?: string
	state?: string
} & Partial<Record<(typeof VIDEO_FACT_FIELDS)[number], unknown>>

export type VideoFactsUpdate = { id: string } & VideoFacts

/**
 * The partial updates that bring indexed docs in line with freshly derived
 * facts. Only docs already in the index are considered — the reconcile repairs
 * facts, it does not decide what gets indexed — and only docs whose facts
 * differ are returned, so a quiet hour writes nothing.
 *
 * A missing field, `null` and `[]` are the same thing to Typesense, so they
 * compare equal; `null` is what clears a field in an `update` import.
 */
export function diffVideoFacts(
	indexed: ReadonlyArray<IndexedVideoFacts>,
	facts: ReadonlyMap<string, VideoFacts>,
): VideoFactsUpdate[] {
	const updates: VideoFactsUpdate[] = []
	for (const doc of indexed) {
		const derived = facts.get(doc.id)
		if (!derived) continue
		const changed = VIDEO_FACT_FIELDS.some(
			(field) => comparable(doc[field]) !== comparable(derived[field]),
		)
		if (changed) updates.push({ id: doc.id, ...derived })
	}
	return updates
}

function comparable(value: unknown): string {
	if (value === undefined || value === null) return 'null'
	if (Array.isArray(value)) {
		return value.length === 0 ? 'null' : JSON.stringify([...value].sort())
	}
	return JSON.stringify(value)
}

export async function exportIndexedVideoFacts(
	client: TypesenseClient,
	collection: string,
): Promise<IndexedVideoFacts[]> {
	const jsonl = await client
		.collections(collection)
		.documents()
		.export({
			include_fields: ['id', 'type', 'visibility', 'state', ...VIDEO_FACT_FIELDS].join(
				',',
			),
		})
	return jsonl
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as IndexedVideoFacts)
}

export async function writeVideoFactsUpdates(
	client: TypesenseClient,
	collection: string,
	updates: ReadonlyArray<VideoFactsUpdate>,
): Promise<{ written: number; failed: number }> {
	if (updates.length === 0) return { written: 0, failed: 0 }

	const results = (await client
		.collections(collection)
		.documents()
		.import(updates as VideoFactsUpdate[], { action: 'update' })) as Array<{
		success: boolean
	}>

	const written = results.filter((result) => result.success).length
	return { written, failed: results.length - written }
}

/**
 * Videos whose whole doc needs rebuilding through the normal save path,
 * because patching facts cannot fix them:
 *
 * - **missing**: a video someone can watch — a public post, or a lesson that
 *   is free or opened by a course — that the index has never seen.
 * - **stale**: the index disagrees with the database on `visibility` or
 *   `state`, as after a direct write that never reindexed.
 */
export function findVideoResourcesToReindex(
	graph: VideoGraph,
	facts: ReadonlyMap<string, VideoFacts>,
	indexed: ReadonlyArray<IndexedVideoFacts>,
): string[] {
	const indexedById = new Map(indexed.map((doc) => [doc.id, doc]))

	return graph.nodes.flatMap((node) => {
		const derived = facts.get(node.id)
		if (!derived?.has_video) return []
		const doc = indexedById.get(node.id)

		if (doc) {
			const stale =
				(doc.visibility ?? null) !== (node.visibility ?? null) ||
				(doc.state ?? null) !== (node.state ?? null)
			return stale ? [node.id] : []
		}

		const watchable =
			node.type === 'post'
				? node.visibility === 'public' && node.state === 'published'
				: derived.free || Boolean(derived.course_ids?.length)
		return watchable ? [node.id] : []
	})
}
