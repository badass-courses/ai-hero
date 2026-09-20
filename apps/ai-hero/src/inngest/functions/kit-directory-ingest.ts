import { db } from '@/db'
import { KIT_DIRECTORY_INGEST_EVENT } from '@/inngest/events/kit-directory'
import { inngest } from '@/inngest/inngest.server'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import { ingestKitDirectoryBatch } from '@/lib/subscriber-marketing/kit-directory-ingest'
import { log } from '@/server/logger'

/**
 * Imports Kit subscribers into the existing ai-hero identity directory.
 *
 * The source export stays local to the operator. The one-off sender publishes
 * bounded batches here; retries are safe because ProviderIdentity is the
 * durable cursor and createContact uses collision-safe ids.
 */
export const kitDirectoryIngest = inngest.createFunction(
	{
		id: 'kit-directory-ingest-v1',
		name: 'Kit directory ingest',
		retries: 3,
		concurrency: { limit: 1 },
	},
	{ event: KIT_DIRECTORY_INGEST_EVENT },
	async ({ event, step }) => {
		const result = await step.run('ingest-kit-directory-batch', () =>
			ingestKitDirectoryBatch({
				repository: new DrizzleCaptureMarketingRepository(db),
				batch: event.data.batch,
				dryRun: event.data.dryRun ?? true,
			}),
		)

		await log.info('kit.directory_ingest.batch_completed', {
			mode: result.mode,
			cursor: result.cursor,
			...result.counts,
		})
		return result
	},
)
