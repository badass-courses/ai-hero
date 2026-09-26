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
			| 'side-effect-intent-failed'
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
			/** A contact's synced profile for drovr (drovr-contact-profile-sync). */
			| 'contact-profile-sync'
	}
}

export const DROVR_CONTACT_PROFILE_SYNC_EVENT =
	'drovr/contact-profile.sync-requested'

/**
 * Push one contact's profile to drovr's contact directory. `valuePathSlug`
 * asks for that path's links to be issued eagerly (journey entry).
 */
export type DrovrContactProfileSyncRequested = {
	name: typeof DROVR_CONTACT_PROFILE_SYNC_EVENT
	data: {
		contactId: string
		reason:
			| 'journey-entered'
			| 'offer-issued'
			/** A contact's first Kit subscriber id: its answer links change. */
			| 'kit-identity-linked'
			/** An operator created a missing contact state (clears stale-state). */
			| 'state-initialized'
			| 'reconcile'
		valuePathSlug?: string
	}
}

export type DrovrDeliverySource = DrovrEventsDeliver['data']['source']

/**
 * The same batches on their own Inngest function, which is its own queue.
 * A per-source concurrency key on the live function was not isolation: a
 * Kit page's thousand one-contact deliveries sat ahead of the live and
 * completion lanes in the shared queue and those waited eleven minutes
 * (2026-09-21 04:44Z). Bulk producers name themselves through `source`;
 * `deliverEventNameFor` routes them here.
 */
export const DROVR_EVENTS_DELIVER_BULK_EVENT = 'drovr/events.deliver.bulk'

export type DrovrEventsDeliverBulk = {
	name: typeof DROVR_EVENTS_DELIVER_BULK_EVENT
	data: DrovrEventsDeliver['data']
}

export type DrovrDeliverEventName =
	| typeof DROVR_EVENTS_DELIVER_EVENT
	| typeof DROVR_EVENTS_DELIVER_BULK_EVENT

/** Sources whose batches travel on the bulk function. */
export const BULK_DELIVERY_SOURCES: ReadonlySet<DrovrDeliverySource> =
	new Set<DrovrDeliverySource>(['kit-directory-ingest'])

export function deliverEventNameFor(
	source: DrovrDeliverySource,
): DrovrDeliverEventName {
	return BULK_DELIVERY_SOURCES.has(source)
		? DROVR_EVENTS_DELIVER_BULK_EVENT
		: DROVR_EVENTS_DELIVER_EVENT
}

/**
 * A double opt-in signup to record with drovr (`POST /signups`), delivered
 * durably: ai-hero owns retrying the POST and drovr is idempotent on the
 * submission. Sent once per form submit, with the submission id as the
 * Inngest event id.
 */
export const DROVR_SIGNUP_REQUESTED_EVENT = 'drovr/signup.requested'

export type DrovrSignupRequested = {
	name: typeof DROVR_SIGNUP_REQUESTED_EVENT
	data: import('@/lib/subscriber-marketing/drovr-doi-signup').DrovrSignupRequest
}
