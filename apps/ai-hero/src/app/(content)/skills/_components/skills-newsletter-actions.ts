'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { getSubscriberFromCookie, setSubscriberCookie } from '@/lib/convertkit'
import {
	SKILLS_NEWSLETTER_SUBSCRIBED_EVENT,
	type SkillsNewsletterSubscribed,
} from '@/inngest/events/skills-newsletter'
import { inngest } from '@/inngest/inngest.server'
import { SubscriberSchema } from '@/schemas/subscriber'
import { log } from '@/server/logger'
import { reconcileAiHeroEmailOptInWithKit } from '@/lib/subscriber-marketing/ai-hero-email-opt-in.server'
import { parseOptInAttributionCookie } from '@/lib/subscriber-marketing/opt-in-attribution'

import {
	SKILLS_FORM_ID,
	SKILLS_HOSTED_RESUBSCRIBE_URL,
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

		const subscribed = SubscriberSchema.parse(updated ?? subscriber)
		const optIn = await reconcileAiHeroEmailOptInWithKit({
			email: subscribed.email_address!,
			subscriberState: subscribed.state,
		})
		if (optIn.status === 'confirmation-required') {
			return {
				success: false as const,
				reason: 'confirmation-required' as const,
				confirmationUrl: SKILLS_HOSTED_RESUBSCRIBE_URL,
			}
		}
		if (updated) {
			await setSubscriberCookie(subscribed)
		}
		await sendSkillsNewsletterPathEntry(subscribed, 'skills:tag-me')

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

async function sendSkillsNewsletterPathEntry(
	input: unknown,
	source: string,
) {
	const subscriber = SubscriberSchema.parse(input)
	if (!subscriber.email_address) {
		throw new Error('Skills newsletter subscriber is missing an email address')
	}
	const cookieStore = await cookies()
	const optInAttribution = parseOptInAttributionCookie(
		cookieStore.get('ft_attr')?.value,
	)
	const event: SkillsNewsletterSubscribed = {
		name: SKILLS_NEWSLETTER_SUBSCRIBED_EVENT,
		data: {
			kitSubscriberId: String(subscriber.id),
			email: subscriber.email_address,
			name: subscriber.first_name ?? undefined,
			formId: SKILLS_FORM_ID,
			source,
			subscribedAt: new Date().toISOString(),
			optInAttribution,
		},
	}
	await inngest.send(event)
}
