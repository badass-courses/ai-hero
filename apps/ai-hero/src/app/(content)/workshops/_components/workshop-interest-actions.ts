'use server'

import { revalidatePath } from 'next/cache'
import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { env } from '@/env.mjs'
import { getSubscriberFromCookie, setSubscriberCookie } from '@/lib/convertkit'
import { SubscriberSchema } from '@/schemas/subscriber'
import { log } from '@/server/logger'

import { workshopInterestFieldKey } from './workshop-interest-config'

/**
 * Tag an already-subscribed visitor as interested in a specific (pre-launch)
 * workshop by setting the per-workshop custom field to today's date.
 *
 * New visitors go through the regular ConvertKit subscribe form (which carries
 * the same field); this action is the one-click path for people who are already
 * on the list, mirroring the skills "tag me" flow.
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
