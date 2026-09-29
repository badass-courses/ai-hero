import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { upsertPostToTypeSense } from '@/lib/typesense-query'
import { computeVideoFacts } from '@/lib/video-facts'
import { loadVideoGraph } from '@/lib/video-facts-query'
import {
	diffVideoFacts,
	exportIndexedVideoFacts,
	findVideoResourcesToReindex,
	writeVideoFactsUpdates,
} from '@/lib/video-facts-reconcile'
import { log } from '@/server/logger'
import { inArray } from 'drizzle-orm'
import Typesense from 'typesense'

import { getTypesenseCollectionName } from '@coursebuilder/utils/typesense-adapter'

import { TYPESENSE_VIDEO_FACTS_RECONCILE_REQUESTED_EVENT } from '../events/typesense-video-facts'
import { inngest } from '../inngest.server'

const REINDEX_BATCH_LIMIT = 100

const TYPESENSE_COLLECTION_NAME = getTypesenseCollectionName({
	envVar: 'NEXT_PUBLIC_TYPESENSE_COLLECTION_NAME',
	defaultValue: 'content_production',
})

/**
 * Keeps the derived video facts (`has_video`, `free`, runtimes) true to the
 * resource graph. Save-time indexing stamps a resource's own facts, but those
 * facts also move when a neighbour changes — a tier flipped in the CMS
 * reorder, a video attached to an existing lesson, a lesson added to a
 * workshop — and none of those paths reindex. Hourly bounds how long /videos
 * can be wrong; the diff keeps a quiet hour to zero writes.
 *
 * Video resources the index is missing, or holds with a stale visibility or
 * state, are rebuilt through the ordinary save path instead: patching facts
 * cannot fix a doc that is absent or wrongly hidden.
 */
export const typesenseVideoFactsReconcile = inngest.createFunction(
	{
		id: 'typesense-video-facts-reconcile',
		name: 'Typesense Video Facts Reconcile',
		concurrency: { limit: 1 },
	},
	[
		{ cron: 'TZ=UTC 17 * * * *' },
		{ event: TYPESENSE_VIDEO_FACTS_RECONCILE_REQUESTED_EVENT },
	],
	async ({ step }) => {
		if (
			!process.env.TYPESENSE_WRITE_API_KEY ||
			!process.env.NEXT_PUBLIC_TYPESENSE_HOST
		) {
			void log.warn('typesense.video-facts.reconcile.config-missing', {
				collection: TYPESENSE_COLLECTION_NAME,
			})
			return { skipped: 'config-missing' }
		}

		// One step: the graph and the export are too large to round-trip
		// through step memoization, and the diff is cheap to redo on retry.
		return step.run('reconcile video facts', async () => {
			const client = new Typesense.Client({
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

			const [graph, indexed] = await Promise.all([
				loadVideoGraph(),
				exportIndexedVideoFacts(client, TYPESENSE_COLLECTION_NAME),
			])
			const facts = computeVideoFacts(graph)

			// Capped so one run stays well inside the function time limit; the
			// rest are picked up next hour.
			const reindexIds = findVideoResourcesToReindex(graph, facts, indexed)
			const batchIds = reindexIds.slice(0, REINDEX_BATCH_LIMIT)
			const toReindex =
				batchIds.length > 0
					? await db.query.contentResource.findMany({
							where: inArray(contentResource.id, batchIds),
							// The save path reads joined resources for the thumbnail.
							with: { resources: { with: { resource: true } } },
						})
					: []
			let reindexed = 0
			for (const resource of toReindex) {
				const upsert = await upsertPostToTypeSense(resource, 'save', {
					videoFacts: facts.get(resource.id) ?? null,
				})
				if (upsert.ok) reindexed += 1
			}

			const updates = diffVideoFacts(indexed, facts)
			const result = await writeVideoFactsUpdates(
				client,
				TYPESENSE_COLLECTION_NAME,
				updates,
			)

			void log.info('typesense.video-facts.reconcile.complete', {
				collection: TYPESENSE_COLLECTION_NAME,
				indexedCount: indexed.length,
				changedCount: updates.length,
				writtenCount: result.written,
				failedCount: result.failed,
				changedSample: updates.slice(0, 10).map((update) => update.id),
				reindexCount: reindexIds.length,
				reindexedCount: reindexed,
				reindexSample: reindexIds.slice(0, 10),
			})

			return {
				indexedCount: indexed.length,
				changedCount: updates.length,
				...result,
				reindexCount: reindexIds.length,
				reindexedCount: reindexed,
			}
		})
	},
)
