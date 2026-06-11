import { db } from '@/db'
import { getTopPages } from '@/lib/analytics/providers/ga4'
import {
	buildPathIndex,
	computePopularityScores,
	fetchIndexablePopularityResources,
	writePopularityScores,
} from '@/lib/typesense-popularity'
import { log } from '@/server/logger'
import Typesense from 'typesense'

import { getTypesenseCollectionName } from '@coursebuilder/utils/typesense-adapter'

import { TYPESENSE_POPULARITY_SYNC_REQUESTED_EVENT } from '../events/typesense-popularity'
import { inngest } from '../inngest.server'

const TYPESENSE_COLLECTION_NAME = getTypesenseCollectionName({
	envVar: 'NEXT_PUBLIC_TYPESENSE_COLLECTION_NAME',
	defaultValue: 'content_production',
})

const GA4_LIMIT = 1000
const GA4_RANGE = '30d' as const

function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}

export const typesensePopularitySync = inngest.createFunction(
	{
		id: 'typesense-popularity-sync',
		name: 'Typesense Popularity Sync',
		concurrency: { limit: 1 },
	},
	[
		{ cron: 'TZ=UTC 0 6 * * *' },
		{ event: TYPESENSE_POPULARITY_SYNC_REQUESTED_EVENT },
	],
	async ({ step }) => {
		const start = Date.now()

		if (
			!process.env.TYPESENSE_WRITE_API_KEY ||
			!process.env.NEXT_PUBLIC_TYPESENSE_HOST
		) {
			void log.warn('typesense.popularity.sync.config-missing', {
				collection: TYPESENSE_COLLECTION_NAME,
				hasWriteKey: !!process.env.TYPESENSE_WRITE_API_KEY,
				hasHost: !!process.env.NEXT_PUBLIC_TYPESENSE_HOST,
			})
			return { skipped: 'config-missing' }
		}

		const gaRows = await step.run('fetch ga4 top pages', async () => {
			return getTopPages(GA4_RANGE, GA4_LIMIT)
		})

		const resources = await step.run('load indexable resources', async () => {
			return fetchIndexablePopularityResources(db)
		})

		const computation = await step.run(
			'compute popularity scores',
			async () => {
				const pathIndex = buildPathIndex(resources)
				const { scores, mapped, unmappedPaths } = computePopularityScores(
					gaRows,
					pathIndex,
				)
				return {
					scoreCount: scores.length,
					mapped,
					unmappedCount: unmappedPaths.length,
					unmappedSample: unmappedPaths.slice(0, 25),
					scores,
				}
			},
		)

		const writeResult = await step.run('write to typesense', async () => {
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
			try {
				return await writePopularityScores(
					client,
					TYPESENSE_COLLECTION_NAME,
					computation.scores,
				)
			} catch (err) {
				void log.error('typesense.popularity.sync.write.failed', {
					collection: TYPESENSE_COLLECTION_NAME,
					scoreCount: computation.scoreCount,
					error: getErrorMessage(err),
				})
				throw err
			}
		})

		const durationMs = Date.now() - start

		void log.info('typesense.popularity.sync.complete', {
			collection: TYPESENSE_COLLECTION_NAME,
			gaRowCount: gaRows.length,
			resourceCount: resources.length,
			mappedCount: computation.mapped,
			unmappedCount: computation.unmappedCount,
			unmappedSample: computation.unmappedSample,
			scoreCount: computation.scoreCount,
			writtenCount: writeResult.written,
			failedCount: writeResult.failed,
			durationMs,
		})

		return {
			gaRowCount: gaRows.length,
			resourceCount: resources.length,
			mappedCount: computation.mapped,
			unmappedCount: computation.unmappedCount,
			scoreCount: computation.scoreCount,
			writtenCount: writeResult.written,
			failedCount: writeResult.failed,
			durationMs,
		}
	},
)
