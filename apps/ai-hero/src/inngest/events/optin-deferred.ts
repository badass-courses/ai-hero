import type { DeadlineTimeZoneEvidence } from '@/lib/subscriber-marketing/course-sequence-exhaustion'
import type { OptInAttribution } from '@/lib/subscriber-marketing/opt-in-attribution'

export const OPTIN_DEFERRED_EVENT = 'aihero/optin.deferred' as const

/**
 * A sign-up whose drovr opt-out state could not be read (timeout or 5xx).
 * The route answers the person with success and leaves the Kit subscribe to
 * `optin-deferred-subscribe`, which subscribes only once drovr says there is
 * no "all" stop. The email travels in the event payload only, never in logs.
 */
export type OptInDeferred = {
	name: typeof OPTIN_DEFERRED_EVENT
	/** Also the Inngest event id: one deferral per submission window. */
	id?: string
	data: {
		submissionKey: string
		email: string
		name?: string
		formId: number
		entry: 'form' | 'tag-me'
		/**
		 * Which action to replay. `form-subscribe` is the form route's Kit form
		 * subscribe; `tag-me` is the signed-in or cookie reader's "Start the
		 * free course" action (same Kit subscribe with the conversion-intent
		 * fields, then its recovery token).
		 */
		action: 'form-subscribe' | 'tag-me'
		tenantId: 'org-aihero'
		fields?: Record<string, unknown>
		page: string
		queuedAt: string
		optInAttribution?: OptInAttribution
		deadlineTimeZone?: DeadlineTimeZoneEvidence
	}
}
