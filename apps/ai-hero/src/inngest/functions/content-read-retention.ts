import { inngest } from '@/inngest/inngest.server'
import { deleteExpiredAnonymousContentReads } from '@/lib/content-read-retention'
import { log } from '@/server/logger'

export const contentReadRetention = inngest.createFunction(
	{
		id: 'content-read-retention',
		name: 'Content Read Retention',
		concurrency: { limit: 1 },
	},
	{ cron: 'TZ=UTC 35 4 * * *' },
	async ({ step }) => {
		const result = await step.run(
			'delete expired anonymous content reads',
			() => deleteExpiredAnonymousContentReads(),
		)
		await log.info('content_read.retention.completed', result)
		return result
	},
)
