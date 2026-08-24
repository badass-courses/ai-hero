'use server'

import { revalidatePath } from 'next/cache'
import {
	WORKSHOP_INTEREST_REQUESTED_EVENT,
	type WorkshopInterestRequested,
} from '@/inngest/events/workshop-interest'
import { inngest } from '@/inngest/inngest.server'
import {
	conversionIntentContract,
	type ConversionSurface,
} from '@/lib/cta/conversion-intent'
import { createSubscriberGateSnapshot } from '@/lib/cta/subscriber-gate-cookie'
import { resolveEnrolmentIdentity } from '@/lib/enrolment-identity'
import { log } from '@/server/logger'

import { workshopInterestFieldKey } from './workshop-interest-config'

/**
 * One-click interest for identified visitors: persist the intent in Inngest
 * and return before Kit is touched. The worker writes the dated field and
 * matching interest_<slug> tag. We do not project the field until Kit confirms it.
 *
 * New visitors go through the intent-aware ConvertKit form, which writes the
 * same field and applies the same derived tag through the shared finalizer.
 */
export async function addWorkshopInterest(
	workshopSlug: string,
	/**
	 * Where the click happened. Changes only the Kit `source` attribution; the
	 * field and tag are the intent's, so a waitlist signup is the same fact
	 * whichever page it was made on.
	 */
	surface: ConversionSurface = 'workshop-page',
) {
	// Cookie OR session — a signed-in reader is identified, so the waitlist does
	// not need to ask for an address the server already has. See
	// `resolveEnrolmentIdentity`.
	const { identity, subscriber } = await resolveEnrolmentIdentity()

	if (!identity) {
		await log.warn('workshop.interest.no.subscriber', {
			workshopSlug,
			hasSubscriber: Boolean(subscriber),
			hasEmail: Boolean(subscriber?.email_address),
			hasSession: false,
		})
		return { success: false, reason: 'not-subscribed' as const }
	}

	const expressedAt = new Date()
	const fieldKey = workshopInterestFieldKey(workshopSlug)
	const contract = conversionIntentContract({
		intent: { kind: 'workshop-interest', workshopSlug },
		surface,
		now: expressedAt,
	})

	const event: WorkshopInterestRequested = {
		name: WORKSHOP_INTEREST_REQUESTED_EVENT,
		data: {
			email: identity.email,
			name: identity.name,
			workshopSlug,
			surface,
			expressedAt: expressedAt.toISOString(),
			via: identity.via,
			subscriberId: subscriber?.id,
		},
	}

	try {
		await inngest.send(event)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		await log.error('workshop.interest.failed', {
			workshopSlug,
			subscriberId: subscriber?.id,
			via: identity.via,
			fieldKey,
			phase: 'enqueue',
			error: message,
		})
		return { success: false, reason: 'request-failed' as const }
	}

	await log.info('workshop.interest.deferred', {
		workshopSlug,
		subscriberId: subscriber?.id,
		via: identity.via,
		fieldKey,
		intentKey: contract.key,
	})

	try {
		revalidatePath(`/workshops/${workshopSlug}`)
	} catch (error) {
		await log.error('workshop.interest.revalidate.failed', {
			workshopSlug,
			error: error instanceof Error ? error.message : String(error),
		})
	}

	const gate = subscriber
		? createSubscriberGateSnapshot(subscriber)
		: { state: null, fields: {} }
	return {
		success: true as const,
		gate: {
			state: gate.state,
			fields: gate.fields,
		},
	}
}
