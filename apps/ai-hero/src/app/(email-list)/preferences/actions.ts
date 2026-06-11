'use server'

import { redirect } from 'next/navigation'
import { parseEmailPreferenceKey } from '@/coursebuilder/email-preferences'
import {
	getEmailPreferenceDefinition,
	syncLocalEmailPreference,
	updateProviderEmailPreference,
	validateKitPreferenceIdentity,
} from '@/lib/email-preferences'
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
