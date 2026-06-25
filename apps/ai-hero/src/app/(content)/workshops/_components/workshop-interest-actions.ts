'use server'

import { revalidatePath } from 'next/cache'
import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { env } from '@/env.mjs'
import { getSubscriberFromCookie, setSubscriberCookie } from '@/lib/convertkit'
import { ensureKitTagId } from '@/lib/kit-tags'
import { SubscriberSchema } from '@/schemas/subscriber'
import { log } from '@/server/logger'

import { workshopInterestFieldKey } from './workshop-interest-config'

/**
 * Apply the per-workshop Kit tag (interest_<slug>) to a subscriber by email.
 * The tag drives Kit automations/segmentation; the custom field keeps the date
 * value. Best-effort: failures are logged but never thrown, so tagging can't
 * break the field write / signup the visitor just completed.
 */
async function applyWorkshopInterestTag({
	email,
	name,
	workshopSlug,
	fieldKey,
}: {
	email: string
	name?: string
	workshopSlug: string
	fieldKey: string
}) {
	try {
		const tagId = await ensureKitTagId(fieldKey)
		if (tagId != null) {
			await emailListProvider.subscribeToList({
				listId: String(tagId),
				listType: 'tag',
				user: { email, name } as any,
				fields: {},
			})
		}
	} catch (error) {
		await log.error('workshop.interest.tag.failed', {
			workshopSlug,
			tagName: fieldKey,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

/**
 * One-click interest for visitors already on the list: set the per-workshop
 * custom field (today's date) and apply the interest_<slug> tag.
 *
 * New visitors go through the regular ConvertKit subscribe form (which carries
 * the same field); they get tagged via `tagWorkshopInterestByEmail` on success.
 */
export async function addWorkshopInterest(workshopSlug: string) {
	const subscriber = await getSubscriberFromCookie()

	if (!subscriber?.id || !subscriber.email_address) {
		await log.warn('workshop.interest.no.subscriber', {
			workshopSlug,
			hasSubscriber: Boolean(subscriber),
			hasEmail: Boolean(subscriber?.email_address),
		})
		return { success: false, reason: 'not-subscribed' as const }
	}

	const fieldKey = workshopInterestFieldKey(workshopSlug)
	const today = new Date().toISOString().slice(0, 10)

	try {
		const updated = await emailListProvider.subscribeToList({
			listId: env.CONVERTKIT_SIGNUP_FORM,
			listType: 'form',
			user: {
				email: subscriber.email_address,
				name: subscriber.first_name ?? undefined,
			} as any,
			fields: { [fieldKey]: today },
		})

		if (updated) {
			await setSubscriberCookie(SubscriberSchema.parse(updated))
		}

		await applyWorkshopInterestTag({
			email: subscriber.email_address,
			name: subscriber.first_name ?? undefined,
			workshopSlug,
			fieldKey,
		})

		await log.info('workshop.interest.success', {
			workshopSlug,
			subscriberId: subscriber.id,
			fieldKey,
		})

		revalidatePath(`/workshops/${workshopSlug}`)

		return { success: true as const }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		await log.error('workshop.interest.failed', {
			workshopSlug,
			subscriberId: subscriber.id,
			fieldKey,
			error: message,
		})
		return { success: false, reason: 'request-failed' as const }
	}
}

/**
 * Apply the interest_<slug> tag to a subscriber by email. Used by the
 * new-subscriber form path: the ConvertKit subscribe form sets the per-workshop
 * custom field but can't apply a tag, so both signup paths tag consistently.
 */
export async function tagWorkshopInterestByEmail(
	email: string,
	workshopSlug: string,
) {
	if (!email) {
		return { success: false, reason: 'no-email' as const }
	}
	const fieldKey = workshopInterestFieldKey(workshopSlug)
	await applyWorkshopInterestTag({ email, workshopSlug, fieldKey })
	return { success: true as const }
}
