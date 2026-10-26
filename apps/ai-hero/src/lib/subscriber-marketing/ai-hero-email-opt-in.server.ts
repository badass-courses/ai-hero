import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { env } from '@/env.mjs'
import { log } from '@/server/logger'

import {
	AI_HERO_UNSUBSCRIBED_TAG_ID,
	reconcileAiHeroEmailOptIn,
	routeReturningUnsubscriber,
} from './ai-hero-email-opt-in'
import {
	DOI_DROVR_FORM_IDS,
	parseDrovrSignupDeliveryConfig,
} from './drovr-doi-signup'
import { requestDrovrDoiSignup } from './drovr-doi-signup.server'
import type { OptInAttribution } from './opt-in-attribution'

export async function reconcileAiHeroEmailOptInWithKit(args: {
	email: string
	subscriberState?: string
}) {
	return reconcileAiHeroEmailOptIn({
		...args,
		getSubscriberByEmail: (email) =>
			emailListProvider.getSubscriberByEmail(email),
		removeUnsubscribeTag: removeAiHeroUnsubscribeTag,
	})
}

/**
 * Call before any Kit subscribe on a Kit sign-up path. A contact Kit shows
 * tagged as an earlier unsubscribe is sent drovr's confirmation email
 * instead (works without DROVR_DOI_FORMS; needs only drovr's base URL and
 * tenant key). Callers stop on anything but `not-unsubscribed`: they must not
 * subscribe to Kit or untag, and answer "check your email" for
 * `doi-requested` or their usual failure for `blocked`.
 */
export async function routeReturningUnsubscriberWithKit(args: {
	email: string
	name?: string
	kitFormId: number
	page: string
	optInAttribution?: OptInAttribution
	entry: 'form' | 'tag-me'
}) {
	const result = await routeReturningUnsubscriber({
		email: args.email,
		drovrConfigured: Boolean(parseDrovrSignupDeliveryConfig(env)),
		formMapped: DOI_DROVR_FORM_IDS.has(args.kitFormId),
		getSubscriberByEmail: (email) =>
			emailListProvider.getSubscriberByEmail(email),
		requestDoi: async () => {
			await requestDrovrDoiSignup(args)
		},
	})
	if (result.status === 'blocked') {
		await log.warn(
			result.reason === 'unmapped-form'
				? 'optin.resubscribe.unmapped_form'
				: 'optin.resubscribe.blocked',
			{ formId: args.kitFormId, reason: result.reason, entry: args.entry },
		)
	} else if (result.status === 'doi-requested') {
		await log.info('optin.resubscribe.doi_requested', {
			formId: args.kitFormId,
			entry: args.entry,
		})
	}
	return result
}

async function removeAiHeroUnsubscribeTag(email: string) {
	const response = await fetch(
		`https://api.convertkit.com/v3/tags/${AI_HERO_UNSUBSCRIBED_TAG_ID}/unsubscribe`,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
				Accept: 'application/json',
			},
			body: JSON.stringify({
				api_secret: env.CONVERTKIT_API_SECRET,
				email,
			}),
		},
	)

	if (!response.ok && response.status !== 404) {
		throw new Error(
			`Kit unsubscribe tag removal failed with HTTP ${response.status}`,
		)
	}
}
