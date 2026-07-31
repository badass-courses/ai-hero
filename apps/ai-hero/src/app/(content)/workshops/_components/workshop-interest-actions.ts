'use server'

import { revalidatePath } from 'next/cache'
import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { env } from '@/env.mjs'
import { getSubscriberFromCookie, setSubscriberCookie } from '@/lib/convertkit'
import {
	conversionIntentContract,
	withConfirmedConversionFields,
} from '@/lib/cta/conversion-intent'
import { resolveEnrolmentIdentity } from '@/lib/enrolment-identity'
import { SubscriberSchema } from '@/schemas/subscriber'
import { log } from '@/server/logger'

import {
	workshopInterestFieldKey,
	workshopInterestTagName,
} from './workshop-interest-config'

/**
 * Apply the per-workshop Kit tag (interest_<slug>) to a subscriber by email.
 * The tag drives Kit automations/segmentation; the custom field keeps the date
 * value. Best-effort: failures are logged but never thrown, so tagging can't
 * break the field write / signup the visitor just completed.
 */
async function applyWorkshopInterestTag({
	email,
	workshopSlug,
}: {
	email: string
	workshopSlug: string
}) {
	const tagName = workshopInterestTagName(workshopSlug)
	try {
		// The provider resolves the tag name to an id (creating the tag on first
		// use) and applies it. tagSubscriber is optional on the interface, but the
		// ConvertKit provider always defines it.
		await emailListProvider.tagSubscriber?.({ tag: tagName, email })
	} catch (error) {
		await log.error('workshop.interest.tag.failed', {
			workshopSlug,
			tagName,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

/**
 * One-click interest for visitors already on the list: set the per-workshop
 * custom field (today's date) and apply the interest_<slug> tag.
 *
 * New visitors go through the intent-aware ConvertKit form, which writes the
 * same field and applies the same derived tag through the shared finalizer.
 */
export async function addWorkshopInterest(workshopSlug: string) {
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

	const fieldKey = workshopInterestFieldKey(workshopSlug)
	const contract = conversionIntentContract({
		intent: { kind: 'workshop-interest', workshopSlug },
		surface: 'workshop-page',
	})

	try {
		// The field write and the tag apply are independent; run them concurrently
		// so the user's one-click isn't stuck behind two serial CK pipelines.
		// applyWorkshopInterestTag is best-effort (never throws), so Promise.all
		// can't reject on a tag failure.
		const [updated] = await Promise.all([
			emailListProvider.subscribeToList({
				listId: env.CONVERTKIT_SIGNUP_FORM,
				listType: 'form',
				user: {
					email: identity.email,
					name: identity.name,
				} as any,
				fields: contract.fields,
			}),
			applyWorkshopInterestTag({
				email: identity.email,
				workshopSlug,
			}),
		])

		if (!updated && !subscriber) {
			throw new Error('Kit did not return a subscriber')
		}

		await setSubscriberCookie(
			SubscriberSchema.parse(
				withConfirmedConversionFields(updated ?? subscriber!, contract.fields),
			),
		)

		await log.info('workshop.interest.success', {
			workshopSlug,
			subscriberId: subscriber?.id,
			via: identity.via,
			fieldKey,
		})

		revalidatePath(`/workshops/${workshopSlug}`)

		return { success: true as const }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		await log.error('workshop.interest.failed', {
			workshopSlug,
			subscriberId: subscriber?.id,
			via: identity.via,
			fieldKey,
			error: message,
		})
		return { success: false, reason: 'request-failed' as const }
	}
}
