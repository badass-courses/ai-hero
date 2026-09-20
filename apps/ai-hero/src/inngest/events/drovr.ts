import type { DrovrShadowEvent } from '@/lib/subscriber-marketing/drovr-shadow-emitter'

/**
 * One batch of drovr EngineEvents to deliver durably. The host maps its
 * facts into drovr's wire contract synchronously and hands the batch to
 * Inngest; the delivery function posts each event with retries. Before
 * this, delivery was a fire-and-forget fetch with a 3s timeout, and about
 * one in four missing shadow births never reached drovr at all
 * (drovr cutover plan, 2026-09-16).
 */
export const DROVR_EVENTS_DELIVER_EVENT = 'drovr/events.deliver'

export type DrovrEventsDeliver = {
	name: typeof DROVR_EVENTS_DELIVER_EVENT
	data: {
		events: DrovrShadowEvent[]
		/** Which host fact produced the batch, for the delivery receipt. */
		source:
			| 'contact-created'
			| 'contact-event'
			| 'kit-webhook'
			| 'side-effect-intent-completed'
			| 'course-completed'
			| 'course-exhausted'
			/** Pre-gate veterans' newsletter births, sent by the veterans function. */
			| 'newsletter-veteran'
			/**
			 * Directory births for contacts the Kit ingest creates. Their own lane:
			 * as `contact-created` they queued live signups behind a bulk page
			 * (2026-09-20 21:37Z, 579 waiting).
			 */
			| 'kit-directory-ingest'
	}
}
