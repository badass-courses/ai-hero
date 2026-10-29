'use server'

import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { env } from '@/env.mjs'
import { setSubscriberCookie } from '@/lib/convertkit'
import { resolveEnrolmentIdentity } from '@/lib/enrolment-identity'
import { SubscriberSchema } from '@/schemas/subscriber'
import { log } from '@/server/logger'

import {
	interestFactsEnabled,
	interestKitWritesEnabled,
} from './interest-facts'
import { requestInterestFacts } from './interest-facts.server'
import { reportVerifiedUnconfirmed } from './verified-unconfirmed'
import {
	conversionIntentContract,
	type GenericKnownConversionIntent,
	type ConversionIntent,
	type ConversionSurface,
	withConfirmedConversionFields,
} from './conversion-intent'

/**
 * Complete an intent without asking a signed-in/list-known reader for an email.
 *
 * Skills-course enrollment deliberately keeps its specialised action because
 * it also starts the learner workflow. Workshops keep theirs because they
 * revalidate the workshop route. The generic seam starts with cohort waitlists
 * and can absorb another intent only when its whole side-effect contract is
 * represented here.
 */
export async function completeKnownConversionIntent({
	intent,
	surface,
}: {
	intent: GenericKnownConversionIntent
	surface: ConversionSurface
}) {
	const { identity, subscriber } = await resolveEnrolmentIdentity()
	const contract = conversionIntentContract({ intent, surface })

	if (!identity) {
		await log.warn('cta.intent.no.identity', {
			intentKey: contract.key,
			surface,
		})
		return { success: false as const, reason: 'not-identified' as const }
	}

	// The join is a local and drovr fact first, whatever Kit does next.
	const { queued } = await requestInterestFacts({
		email: identity.email,
		fields: contract.fields,
		via: 'one-click',
	})
	if (queued > 0 && !interestKitWritesEnabled()) {
		// The cut. The fact is the join; the gate cookie reflects it at once.
		// No list state is read here, so no confirmation is claimed either.
		if (subscriber) {
			await setSubscriberCookie(
				SubscriberSchema.parse(
					withConfirmedConversionFields(subscriber, contract.fields),
				),
			)
		}
		await log.info('cta.intent.completed', {
			intentKey: contract.key,
			surface,
			via: identity.via,
			store: 'interest-facts',
		})
		return { success: true as const, confirmationRequired: false as const }
	}

	try {
		const updated = await emailListProvider.subscribeToList({
			listId: contract.formId ?? env.CONVERTKIT_SIGNUP_FORM,
			listType: 'form',
			user: {
				email: identity.email,
				name: identity.name,
			} as any,
			fields: contract.fields,
		})

		if (!updated && !subscriber) {
			throw new Error('Kit did not return a subscriber')
		}

		const subscribed = SubscriberSchema.parse(
			withConfirmedConversionFields(updated ?? subscriber!, contract.fields),
		)
		await setSubscriberCookie(subscribed)

		// The field is canonical. A tag is a derived Kit projection, so a tag API
		// failure is logged for repair but cannot turn this successful field write
		// into an error under the reader's cursor.
		await finalizeAnonymousConversionIntent({
			intent,
			surface,
			email: identity.email,
		})

		await log.info('cta.intent.completed', {
			intentKey: contract.key,
			surface,
			via: identity.via,
			subscriberId: subscribed.id,
		})

		if (subscribed.state !== 'active') {
			await reportVerifiedUnconfirmed({
				identity,
				subscriber: subscribed,
				intentKey: contract.key,
			})
			return { success: true as const, confirmationRequired: true as const }
		}

		return { success: true as const, confirmationRequired: false as const }
	} catch (error) {
		await log.error('cta.intent.failed', {
			intentKey: contract.key,
			surface,
			via: identity.via,
			error: error instanceof Error ? error.message : String(error),
		})
		return { success: false as const, reason: 'request-failed' as const }
	}
}

/**
 * Finish the derived projections after the canonical Kit form write.
 *
 * A tag is useful for Kit automations, but the dated/interest field is what the
 * product uses to decide whether the intent is complete. Tag failure therefore
 * never turns a successful subscription into a false browser failure; it is
 * logged with the stable intent key so reconciliation can repair it.
 */
export async function finalizeAnonymousConversionIntent({
	intent,
	surface,
	email,
}: {
	intent: ConversionIntent
	surface: ConversionSurface
	email: string
}) {
	const contract = conversionIntentContract({ intent, surface })
	if (!contract.tagName) return { success: true as const }
	// After the cut the tag is a Kit projection nobody reads, but only once the
	// fact holds the join. Re-requesting is idempotent (the event id is the
	// list and the address hash), and a failed queue keeps the Kit tag.
	if (interestFactsEnabled() && !interestKitWritesEnabled()) {
		const { queued } = await requestInterestFacts({
			email,
			fields: contract.fields,
			via: 'form',
		})
		if (queued > 0) return { success: true as const }
	}

	try {
		await emailListProvider.tagSubscriber?.({
			tag: contract.tagName,
			email,
		})
		return { success: true as const }
	} catch (error) {
		await log.error('cta.intent.tag.failed', {
			intentKey: contract.key,
			tagName: contract.tagName,
			error: error instanceof Error ? error.message : String(error),
		})
		return { success: false as const, reason: 'tag-failed' as const }
	}
}
