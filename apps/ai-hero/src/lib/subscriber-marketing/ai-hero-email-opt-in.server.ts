import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { env } from '@/env.mjs'
import {
	gatedAsksOffKitEnabled,
	readGatedAskForEmailFresh,
} from '@/lib/gated-asks-off-kit'
import { kitMirrorWritesEnabled } from '@/lib/kit-mirror-writes'
import { log } from '@/server/logger'

import {
	AI_HERO_UNSUBSCRIBED_TAG_ID,
	reconcileAiHeroEmailOptIn,
	routeReturningUnsubscriber,
	type ReturningUnsubscriberResult,
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
	if (gatedAsksOffKitEnabled()) {
		const { list } = await readGatedAskForEmailFresh(args.email)
		return list?.state === 'confirmed'
			? { status: 'active' as const, removedUnsubscribeTag: false }
			: { status: 'confirmation-required' as const }
	}
	// The unsubscribe tag is a Kit mirror: with the mirror switch off, an
	// active subscriber is simply active and nothing reads or writes Kit.
	if (!kitMirrorWritesEnabled()) {
		return args.subscriberState === 'active'
			? { status: 'active' as const, removedUnsubscribeTag: false }
			: { status: 'confirmation-required' as const }
	}
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
type ReturningUnsubscriberInput = {
	email: string
	name?: string
	kitFormId: number
	page: string
	optInAttribution?: OptInAttribution
	entry: 'form' | 'tag-me'
}

export async function routeReturningUnsubscriberWithKit(
	args: ReturningUnsubscriberInput,
): Promise<ReturningUnsubscriberResult> {
	const drovrConfig = parseDrovrSignupDeliveryConfig(env)
	const result = gatedAsksOffKitEnabled()
		? await routeReturningUnsubscriberOffKit(args, drovrConfig)
		: await routeReturningUnsubscriber({
				email: args.email,
				drovrConfigured: Boolean(drovrConfig),
				formMapped: DOI_DROVR_FORM_IDS.has(args.kitFormId),
				getSubscriberByEmail: (email) =>
					emailListProvider.getSubscriberByEmail(email),
				getDrovrStops: async (kitSubscriberId) => {
					try {
						return await readDrovrOptOuts(
							kitSubscriberId,
							drovrConfig && {
								...drovrConfig,
								// Latency per call, for p50/p95 in Axiom. No ids or addresses.
								onRead: ({ ms, status }) =>
									log.info('optin.drovr_stops.read', {
										ms,
										status,
										entry: args.entry,
									}),
							},
						)
					} catch (error) {
						await log.warn('optin.resubscribe.drovr_unknown', {
							error: error instanceof Error ? error.name : 'unknown',
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

/** Same consent gate, without using a Kit record or interpreting no stops as consent. */
async function routeReturningUnsubscriberOffKit(
	args: ReturningUnsubscriberInput,
	config: ReturnType<typeof parseDrovrSignupDeliveryConfig>,
): Promise<ReturningUnsubscriberResult> {
	const { list } = await readGatedAskForEmailFresh(args.email)
	if (
		list?.stops.some(
			(stop) => stop.scope === 'all' && stop.reason !== 'unsubscribed',
		)
	) {
		return { status: 'blocked', reason: 'suppressed' }
	}
	if (list?.state === 'confirmed' || list?.state === 'unconfirmed')
		return { status: 'not-unsubscribed' }
	if (!DOI_DROVR_FORM_IDS.has(args.kitFormId))
		return { status: 'blocked', reason: 'unmapped-form' }
	if (!config) return { status: 'blocked', reason: 'drovr-unconfigured' }
	await requestDrovrDoiSignup(args)
	return { status: 'doi-requested' }
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
