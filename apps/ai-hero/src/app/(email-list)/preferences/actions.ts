'use server'

import { redirect } from 'next/navigation'
import { parseEmailPreferenceKey } from '@/coursebuilder/email-preferences'
import { env } from '@/env.mjs'
import {
	acceptKitLinkPreferenceChange,
	getEmailPreferenceDefinition,
	syncLocalEmailPreference,
	updateProviderEmailPreference,
	validateKitPreferenceIdentity,
	verifyKitPreferenceLinkLocally,
} from '@/lib/email-preferences'
import { emailPreferencesLocalEnabled } from '@/lib/email-preferences-local'
import { log } from '@/server/logger'

/**
 * Updates a subscriber's email preference from the public preference center.
 */
export async function updateEmailPreferenceAction(formData: FormData) {
	const subscriberId = formData.get('ck_subscriber_id')?.toString()
	const shKit = formData.get('sh_kit')?.toString()
	const preferenceKey = parseEmailPreferenceKey(
		formData.get('preference')?.toString(),
	)
	const subscribed = formData.get('subscribed')?.toString() === 'true'
	const preference = getEmailPreferenceDefinition(preferenceKey)

	if (emailPreferencesLocalEnabled(env)) {
		// Kit stays out of the request. An opt-out always lands; an opt-in
		// is refused: a link cannot resubscribe anyone.
		const verification = await verifyKitPreferenceLinkLocally({
			subscriberId,
			shKit,
			source: 'preferences-page',
			route: '/preferences',
		})
		const result =
			subscriberId && shKit
				? await acceptKitLinkPreferenceChange({
						verification,
						subscriberId,
						shKit,
						preference,
						subscribed,
						source: 'preferences-page',
					})
				: ({ status: 'rejected', reason: 'invalid-link' } as const)

		if (result.status === 'rejected') {
			redirect(
				result.reason === 'link-opt-in-refused'
					? '/preferences?error=sign-in-to-resubscribe'
					: '/preferences?error=invalid-link',
			)
		}

		redirect(
			`/preferences?${new URLSearchParams({
				ck_subscriber_id: subscriberId ?? '',
				sh_kit: shKit ?? '',
				updated: preferenceKey,
				state: subscribed ? 'subscribed' : 'unsubscribed',
			}).toString()}`,
		)
	}

	const subscriber = await validateKitPreferenceIdentity({
		subscriberId,
		shKit,
		source: 'preferences-page',
		route: '/preferences',
	})

	if (!subscriber) {
		redirect('/preferences?error=invalid-link')
	}

	const state = await updateProviderEmailPreference({
		subscriberId,
		subscriberEmail: subscriber.email_address ?? undefined,
		preference,
		subscribed,
		source: 'preferences-page',
	})

	await syncLocalEmailPreference({
		email: subscriber.email_address,
		preference,
		subscribed: state.subscribed,
		source: 'preferences-page',
	})

	await log.info(
		state.subscribed
			? 'email-preferences.opt-in'
			: 'email-preferences.unsubscribe',
		{
			source: 'preferences-page',
			provider: 'convertkit',
			kitSubscriberId: subscriberId,
			shKit,
			preferenceKey,
			result: state.status,
		},
	)

	const params = new URLSearchParams({
		ck_subscriber_id: subscriberId ?? '',
		sh_kit: shKit ?? '',
		updated: preferenceKey,
		state: state.status,
	})

	redirect(`/preferences?${params.toString()}`)
}
