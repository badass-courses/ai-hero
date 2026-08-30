import { db } from '@/db'
import { CONTACT_UNSUBSCRIBED_EVENT } from '@/inngest/events/contact-unsubscribed'
import { inngest } from '@/inngest/inngest.server'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import { writeContactUnsubscribedContactEvents } from '@/lib/subscriber-marketing/lifecycle-contact-events'
import { log } from '@/server/logger'

/**
 * Mirrors an email-preference opt-out into the ContactEvent log as
 * contact.unsubscribed so marketing history replays stop planning email for
 * the contact. The emitting preference flows never wait on this function.
 */
export const captureContactUnsubscribed = inngest.createFunction(
	{
		id: 'capture-contact-unsubscribed',
		name: 'Capture Contact Unsubscribed Event',
		retries: 3,
	},
	{ event: CONTACT_UNSUBSCRIBED_EVENT },
	async ({ event, step }) => {
		// Only counts leave the step: the full summary's decisions/written
		// arrays drag Drizzle record types through Jsonify.
		const summary = await step.run(
			'write contact-unsubscribed contact event',
			async () => {
				const result = await writeContactUnsubscribedContactEvents({
					repository: new DrizzleCaptureMarketingRepository(db),
					rows: [
						{
							email: event.data.email,
							kitSubscriberId: event.data.kitSubscriberId,
							preferenceKey: event.data.preferenceKey,
							source: event.data.source,
							occurredAt: event.data.occurredAt,
						},
					],
				})
				return { counts: result.counts }
			},
		)

		await log.info('contact_event.contact_unsubscribed.captured', {
			preferenceKey: event.data.preferenceKey,
			source: event.data.source,
			kitSubscriberId: event.data.kitSubscriberId,
			written: summary.counts.written,
			skippedByReason: summary.counts.skippedByReason,
		})

		return {
			status: summary.counts.written > 0 ? 'written' : 'skipped',
			counts: summary.counts,
		}
	},
)
