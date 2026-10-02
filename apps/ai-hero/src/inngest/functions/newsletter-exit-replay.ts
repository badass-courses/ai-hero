import { z } from 'zod'
import { db } from '@/db'
import { inngest } from '@/inngest/inngest.server'
import { NEWSLETTER_EXIT_CONFIRMED_EVENT } from '@/inngest/events/newsletter-exit'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import { replayNewsletterExitReceipt } from '@/lib/subscriber-marketing/newsletter-exit-replay'
import { log } from '@/server/logger'

const notification = z.object({
	contactId: z.string().min(1),
	receiptId: z.string().min(1),
})
export const newsletterExitReplay = inngest.createFunction(
	{
		id: 'newsletter-exit-replay-v1',
		name: 'Newsletter: resume verified exit holds',
		retries: 3,
		concurrency: { limit: 1, key: 'event.data.contactId' },
	},
	{ event: NEWSLETTER_EXIT_CONFIRMED_EVENT },
	async ({ event, step }) => {
		const parsed = notification.safeParse(event.data)
		if (!parsed.success) return { status: 'invalid-notification' }
		const result = await step.run(
			'verify-exit-and-replay-held-newsletter',
			() =>
				replayNewsletterExitReceipt({
					repository: new DrizzleCaptureMarketingRepository(db),
					...parsed.data,
					now: new Date().toISOString(),
				}),
		)
		await log.info('newsletter.exit_replay', {
			contactId: parsed.data.contactId,
			...result,
		})
		return result
	},
)
