import { inngest } from '@/inngest/inngest.server'
import {
	ANONYMOUS_CONTENT_READ_RETENTION_DAYS,
	CONTENT_READ_RETENTION_BATCH_SIZE,
	CONTENT_READ_RETENTION_MAX_BATCHES,
	deleteExpiredAnonymousContentReadBatch,
	getContentReadRetentionCutoff,
} from '@/lib/content-read-retention'
import { log } from '@/server/logger'

export const contentReadRetention = inngest.createFunction(
	{
		id: 'content-read-retention',
		name: 'Content Read Retention',
		concurrency: { limit: 1 },
	},
	{ cron: 'TZ=UTC 35 4 * * *' },
	async ({ step }) => {
		const cutoffIso = await step.run('compute retention cutoff', () =>
			getContentReadRetentionCutoff().cutoff.toISOString(),
		)
		const cutoff = new Date(cutoffIso)

		let deletedCount = 0
		let after: Date | undefined
		for (let batch = 0; batch < CONTENT_READ_RETENTION_MAX_BATCHES; batch++) {
			const result = await step.run(`delete expired batch ${batch}`, () =>
				deleteExpiredAnonymousContentReadBatch({ cutoff, after }),
			)
			deletedCount += result.deletedCount
			if (result.lastOccurredAt) after = new Date(result.lastOccurredAt)
			if (result.selectedCount < CONTENT_READ_RETENTION_BATCH_SIZE) break
		}

		const result = {
			mode: 'write' as const,
			retentionDays: ANONYMOUS_CONTENT_READ_RETENTION_DAYS,
			cutoff: cutoffIso,
			deletedCount,
		}
		await log.info('content_read.retention.completed', result)
		return result
	},
)
