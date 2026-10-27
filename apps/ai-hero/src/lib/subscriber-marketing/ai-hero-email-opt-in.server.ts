import { createHash } from 'node:crypto'
import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { env } from '@/env.mjs'
import { OPTIN_DEFERRED_EVENT } from '@/inngest/events/optin-deferred'
import { inngest } from '@/inngest/inngest.server'
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
import type { DeadlineTimeZoneEvidence } from './course-sequence-exhaustion'
import { DROVR_AUTHORITY_TENANT_ID } from './drovr-shadow-emitter'
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

const DEFER_WINDOW_MS = 30 * 60 * 1000

/** Stable, non-reversible handle for logs and event ids; never the address. */
export function optInEmailHash(email: string) {
	return createHash('sha256')
		.update(email.trim().toLowerCase())
		.digest('hex')
		.slice(0, 16)
}

/** One deferral per person, form and half hour: a double submit queues once. */
export function optInDeferralKey(email: string, formId: number, now: number) {
	return `${optInEmailHash(email)}:${formId}:${Math.floor(now / DEFER_WINDOW_MS)}`
}

/**
 * Pass `deferral` from a caller that can finish the sign-up later. Without
 * it, an unreadable drovr state stays `blocked/drovr-unknown`.
 */
export type OptInDeferralInput = {
	/** False for the deferred function itself: report `deferred`, never re-queue. */
	queue?: boolean
	fields?: Record<string, unknown>
	deadlineTimeZone?: DeadlineTimeZoneEvidence
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
	deferral?: OptInDeferralInput
}) {
	const drovrConfig = parseDrovrSignupDeliveryConfig(env)
	const doiEnabled = env.AIH_RESUBSCRIBE_DOI_ENABLED === 'true'
	const routed = await routeReturningUnsubscriber({
		email: args.email,
		doiEnabled,
		drovrConfigured: Boolean(drovrConfig),
		formMapped: DOI_DROVR_FORM_IDS.has(args.kitFormId),
		getSubscriberByEmail: (email) =>
			emailListProvider.getSubscriberByEmail(email),
		deferUnknown: Boolean(args.deferral),
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
	const result = await queueDeferral(routed, args)
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

/**
 * A deferred sign-up is queued for the retrying function; if it cannot be
 * queued, nothing will ever finish it, so it falls back to the old block
 * rather than telling the person it worked.
 */
async function queueDeferral<
	R extends Awaited<ReturnType<typeof routeReturningUnsubscriber>>,
>(
	result: R,
	args: {
		email: string
		name?: string
		kitFormId: number
		page: string
		optInAttribution?: OptInAttribution
		entry: 'form' | 'tag-me'
		deferral?: OptInDeferralInput
	},
): Promise<R | { status: 'blocked'; reason: 'drovr-unknown' }> {
	if (result.status !== 'deferred' || args.deferral?.queue === false) {
		return result
	}
	const now = Date.now()
	const submissionKey = optInDeferralKey(args.email, args.kitFormId, now)
	const emailHash = optInEmailHash(args.email)
	try {
		await inngest.send({
			id: `optin-deferred:${submissionKey}`,
			name: OPTIN_DEFERRED_EVENT,
			data: {
				submissionKey,
				email: args.email,
				name: args.name,
				formId: args.kitFormId,
				entry: args.entry,
				tenantId: DROVR_AUTHORITY_TENANT_ID,
				fields: args.deferral?.fields,
				page: args.page,
				queuedAt: new Date(now).toISOString(),
				optInAttribution: args.optInAttribution,
				deadlineTimeZone: args.deferral?.deadlineTimeZone,
			},
		})
	} catch (error) {
		await log.error('optin.deferred.queue_failed', {
			formId: args.kitFormId,
			entry: args.entry,
			emailHash,
			error: error instanceof Error ? error.name : 'unknown',
		})
		return { status: 'blocked', reason: 'drovr-unknown' }
	}
	await log.info('optin.deferred.queued', {
		formId: args.kitFormId,
		entry: args.entry,
		emailHash,
		submissionKey,
	})
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
