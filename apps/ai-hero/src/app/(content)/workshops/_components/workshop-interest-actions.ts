'use server'

import { revalidatePath } from 'next/cache'
import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { env } from '@/env.mjs'
import { getSubscriberFromCookie, setSubscriberCookie } from '@/lib/convertkit'
import { ensureKitTagId } from '@/lib/kit-tags'
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
	name,
	workshopSlug,
}: {
	email: string
	name?: string
	workshopSlug: string
}) {
	const tagName = workshopInterestTagName(workshopSlug)
	try {
		const tagId = await ensureKitTagId(tagName)
		if (tagId != null) {
			await emailListProvider.subscribeToList({
				listId: String(tagId),
				listType: 'tag',
				user: { email, name } as any,
				// No fields to write on a tag subscribe. The provider runs an extra
				// PUT /subscribers when `fields` is truthy, so pass undefined to skip
				// it (the type requires the key; the runtime check is `if (fields)`).
				fields: undefined as unknown as Record<string, string>,
			})
		}
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
		// The field write and the tag apply are independent; run them concurrently
		// so the user's one-click isn't stuck behind two serial CK pipelines.
		// applyWorkshopInterestTag is best-effort (never throws), so Promise.all
		// can't reject on a tag failure.
		const [updated] = await Promise.all([
			emailListProvider.subscribeToList({
				listId: env.CONVERTKIT_SIGNUP_FORM,
				listType: 'form',
				user: {
					email: subscriber.email_address,
					name: subscriber.first_name ?? undefined,
				} as any,
				fields: { [fieldKey]: today },
			}),
			applyWorkshopInterestTag({
				email: subscriber.email_address,
				name: subscriber.first_name ?? undefined,
				workshopSlug,
			}),
		])

		if (updated) {
			await setSubscriberCookie(SubscriberSchema.parse(updated))
		}

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
	await applyWorkshopInterestTag({ email, workshopSlug })
	return { success: true as const }
}
