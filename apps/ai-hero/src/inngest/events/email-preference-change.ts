export const EMAIL_PREFERENCE_CHANGE_REQUESTED_EVENT =
	'email-preferences/change-requested' as const

/**
 * A preference change from a Kit-signed link, accepted on the page with Kit
 * out of the request path. `apply-email-preference-change` finishes it: the
 * opt-out ContactEvent (which carries the stop to drovr) and the Kit
 * preference write, which stays until the last Kit send.
 *
 * `email` is set only when the page verified the link against the directory.
 * Without it the function verifies first, and drops anything that fails.
 * An opt-in is only ever queued verified: nothing unverified lifts a stop.
 */
export type EmailPreferenceChangeRequested = {
	name: typeof EMAIL_PREFERENCE_CHANGE_REQUESTED_EVENT
	data: {
		kitSubscriberId: string
		shKit: string
		preferenceKey: string
		subscribed: boolean
		source: 'preferences-page' | 'unsubscribe-link'
		requestedAt: string
		email?: string
		/** The page already wrote the local preference row. */
		localSynced?: boolean
	}
}
