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
import { readDrovrOptOuts } from './drovr-opt-out-reader'
import type { OptInAttribution } from './opt-in-attribution'

export async function reconcileAiHeroEmailOptInWithKit(args: {
	email: string
	subscriberState?: string
	mayRemoveUnsubscribeTag?: boolean
}) {
	const result = await reconcileAiHeroEmailOptIn({
		...args,
		getSubscriberByEmail: (email) =>
			emailListProvider.getSubscriberByEmail(email),
		removeUnsubscribeTag: removeAiHeroUnsubscribeTag,
	})
	if (result.status === 'active' && result.untagSkipped) {
		await log.warn('optin.resubscribe.untag_skipped', {})
	}
	return result
}

/**
 * Call before any Kit subscribe on a Kit sign-up path. An earlier unsubscribe
 * tagged in Kit or stopped only in drovr is sent drovr's confirmation email
 * instead (works without DROVR_DOI_FORMS; needs only drovr's base URL and
 * tenant key). Callers continue on `not-unsubscribed` or `lookup-failed`
 * (without untagging on a failed lookup). Otherwise they must not subscribe
 * to Kit or untag, and answer "check your email" for `doi-requested` or their
 * usual failure for `blocked`.
 */
export async function routeReturningUnsubscriberWithKit(args: {
	email: string
	name?: string
	kitFormId: number
	page: string
	optInAttribution?: OptInAttribution
	entry: 'form' | 'tag-me'
}) {
	const drovrConfig = parseDrovrSignupDeliveryConfig(env)
	const doiEnabled = env.AIH_RESUBSCRIBE_DOI_ENABLED === 'true'
	const result = await routeReturningUnsubscriber({
		email: args.email,
		doiEnabled,
		drovrConfigured: Boolean(drovrConfig),
		formMapped: DOI_DROVR_FORM_IDS.has(args.kitFormId),
		getSubscriberByEmail: (email) =>
			emailListProvider.getSubscriberByEmail(email),
		getDrovrStops: async (kitSubscriberId) => {
			try {
				return await readDrovrOptOuts(kitSubscriberId, drovrConfig, () =>
					log.warn('optin.resubscribe.drovr_unexpected_page', {}),
				)
			} catch (error) {
				await log.warn('optin.resubscribe.drovr_unknown', {
					error: error instanceof Error ? error.name : 'unknown',
					doiEnabled,
				})
				throw error
			}
		},
		requestDoi: async () => {
			await requestDrovrDoiSignup(args)
		},
	})
	if (result.status === 'lookup-failed') {
		await log.warn('optin.resubscribe.lookup_failed', {
			formId: args.kitFormId,
			entry: args.entry,
		})
	} else if (result.status === 'blocked') {
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
