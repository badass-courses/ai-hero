import { parseEmailPreferenceKey } from '@/coursebuilder/email-preferences'
import { CONTACT_UNSUBSCRIBED_EVENT } from '@/inngest/events/contact-unsubscribed'
import { EMAIL_PREFERENCE_CHANGE_REQUESTED_EVENT } from '@/inngest/events/email-preference-change'
import { inngest } from '@/inngest/inngest.server'
import { applyEmailPreferenceChange } from '@/lib/email-preference-change'
import {
	getEmailPreferenceDefinition,
	syncLocalEmailPreference,
	updateProviderEmailPreference,
	validateKitPreferenceIdentity,
	verifyKitPreferenceLinkLocally,
} from '@/lib/email-preferences'
import { log } from '@/server/logger'

/**
 * Finishes a preference change the page accepted with Kit out of the request
 * path. Each piece is its own step, so
 * a Kit outage retries only the Kit write and never loses the opt-out.
 */
export const applyEmailPreferenceChangeFunction = inngest.createFunction(
	{
		id: 'apply-email-preference-change',
		name: 'Apply Email Preference Change',
		retries: 10,
	},
	{ event: EMAIL_PREFERENCE_CHANGE_REQUESTED_EVENT },
	async ({ event, step }) => {
		const data = event.data
		const preference = getEmailPreferenceDefinition(
			parseEmailPreferenceKey(data.preferenceKey),
		)
		const route =
			data.source === 'unsubscribe-link' ? '/unsubscribed' : '/preferences'

		const result = await applyEmailPreferenceChange(data, {
			verify: () =>
				step.run('verify link against the directory', async () => {
					const verification = await verifyKitPreferenceLinkLocally({
						subscriberId: data.kitSubscriberId,
						shKit: data.shKit,
						source: data.source,
						route,
					})
					// Throw inside the step so a retry reads again instead of
					// replaying a memoized outage.
					if (
						verification.status === 'unverifiable' &&
						verification.reason === 'directory-unavailable'
					) {
						throw new Error('Contact directory unavailable')
					}
					return verification
				}),
			verifyWithKit: () =>
				step.run('verify link with Kit', async () => {
					const subscriber = await validateKitPreferenceIdentity({
						subscriberId: data.kitSubscriberId,
						shKit: data.shKit,
						source: data.source,
						route,
					})
					return subscriber?.email_address ?? null
				}),
			syncLocal: (email) =>
				step.run('mirror local preference', () =>
					syncLocalEmailPreference({
						email,
						preference,
						subscribed: data.subscribed,
						source: data.source,
					}),
				),
			recordOptOut: (email) =>
				step.sendEvent('record opt-out contact event', {
					name: CONTACT_UNSUBSCRIBED_EVENT,
					data: {
						email,
						kitSubscriberId: data.kitSubscriberId,
						preferenceKey: preference.key,
						source: data.source,
						occurredAt: data.requestedAt,
					},
				}),
			// Stays until the last Kit send reads these preferences.
			writeKit: (email) =>
				step.run('write Kit preference', async () => {
					const state = await updateProviderEmailPreference({
						subscriberId: data.kitSubscriberId,
						subscriberEmail: email,
						preference,
						subscribed: data.subscribed,
						source: data.source,
					})
					return { status: state.status }
				}),
		})

		await log.info('email-preferences.change.applied', {
			source: data.source,
			kitSubscriberId: data.kitSubscriberId,
			preferenceKey: preference.key,
			result: data.subscribed ? 'subscribed' : 'unsubscribed',
			...result,
		})
		return result
	},
)
