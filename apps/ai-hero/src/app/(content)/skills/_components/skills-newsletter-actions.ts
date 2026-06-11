'use server'

import { revalidatePath } from 'next/cache'
import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { getSubscriberFromCookie, setSubscriberCookie } from '@/lib/convertkit'
import { SubscriberSchema } from '@/schemas/subscriber'
import { log } from '@/server/logger'

import {
	SKILLS_FORM_ID,
	SKILLS_INTEREST_FIELDS,
} from './skills-newsletter-config'

export async function tagSubscriberAsSkills() {
	const subscriber = await getSubscriberFromCookie()

	if (!subscriber?.id || !subscriber.email_address) {
		await log.warn('skills.tagme.no.subscriber', {
			hasSubscriber: Boolean(subscriber),
			hasEmail: Boolean(subscriber?.email_address),
		})
		return { success: false, reason: 'not-subscribed' as const }
	}

	try {
		const updated = await emailListProvider.subscribeToList({
			listId: SKILLS_FORM_ID,
			listType: 'form',
			user: {
				email: subscriber.email_address,
				name: subscriber.first_name ?? undefined,
			} as any,
			fields: { ...SKILLS_INTEREST_FIELDS },
		})

		if (updated) {
			await setSubscriberCookie(SubscriberSchema.parse(updated))
		}

		await log.info('skills.tagme.success', {
			subscriberId: subscriber.id,
			formId: SKILLS_FORM_ID,
		})

		revalidatePath('/skills')

		return { success: true as const }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		await log.error('skills.tagme.failed', {
			subscriberId: subscriber.id,
			formId: SKILLS_FORM_ID,
			error: message,
		})
		return { success: false, reason: 'request-failed' as const }
	}
}
