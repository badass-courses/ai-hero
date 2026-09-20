import { db } from '@/db'
import { NEWSLETTER_VETERANS_ASSIGN_EVENT } from '@/inngest/events/newsletter-veterans'
import { inngest } from '@/inngest/inngest.server'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import { assignNewsletterVeteransBatch } from '@/lib/subscriber-marketing/newsletter-veterans'
import { log } from '@/server/logger'

/**
 * Assigns drovr newsletter ownership to contacts that predate the signup
 * gate. The operator script publishes small batches; each assignment is a
 * contact event the repository dispatches to drovr as the newsletter birth.
 */
export const newsletterVeteransAssign = inngest.createFunction(
	{
		id: 'newsletter-veterans-assign-v1',
		name: 'Newsletter veterans: assign drovr ownership',
		retries: 3,
		concurrency: { limit: 1 },
	},
	{ event: NEWSLETTER_VETERANS_ASSIGN_EVENT },
	async ({ event, step }) => {
		const result = await step.run('assign-newsletter-veterans-batch', () =>
			assignNewsletterVeteransBatch({
				repository: new DrizzleCaptureMarketingRepository(db),
				batch: event.data.batch,
				dryRun: event.data.dryRun ?? true,
			}),
		)

		await log.info('newsletter.veterans.batch_completed', {
			mode: result.mode,
			...result.counts,
		})
		return result
	},
)
