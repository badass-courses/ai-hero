'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { getSubscriberFromCookie, setSubscriberCookie } from '@/lib/convertkit'
import { getServerAuthSession } from '@/server/auth'
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

/**
 * The signed-in reader's own address, when there is one.
 *
 * Never takes an address from the caller: the email comes off the server-side
 * session, so this cannot be used to enrol somebody else.
 */
async function sessionIdentity() {
	const auth = await getServerAuthSession().catch(() => null)
	const email = auth?.session?.user?.email
	if (!email) return null
	return {
		email,
		name: auth?.session?.user?.name ?? undefined,
		via: 'session' as const,
	}
}

export async function tagSubscriberAsSkills(source = 'skills:tag-me') {
	const subscriber = await getSubscriberFromCookie()

	// A SIGNED-IN reader is identified, cookie or no cookie. They logged in from
	// a link sent to this address, which is stronger evidence than an address
	// typed into a form — so requiring them to type it anyway was asking a known
	// person to prove something they had already proved.
	//
	// The Kit cookie still wins when it exists: it carries the Kit subscriber
	// record, and enroling against a stale session address for someone who has
	// since changed their Kit email would split them into two subscribers.
	const identity = subscriber?.email_address
		? {
				email: subscriber.email_address,
				name: subscriber.first_name ?? undefined,
				via: 'cookie' as const,
			}
		: await sessionIdentity()

	if (!identity) {
		await log.warn('skills.tagme.no.subscriber', {
			hasSubscriber: Boolean(subscriber),
			hasEmail: Boolean(subscriber?.email_address),
			hasSession: false,
		})
		return { success: false, reason: 'not-subscribed' as const }
	}

	try {
		const updated = await emailListProvider.subscribeToList({
			listId: SKILLS_FORM_ID,
			listType: 'form',
			user: {
				email: identity.email,
				name: identity.name,
			} as any,
			fields: { ...SKILLS_INTEREST_FIELDS, source },
		})

		// `?? subscriber` no longer holds for the session path: there may be no
		// cookie record to fall back to, and parsing `undefined` would throw
		// inside the try and report a failure over a Kit call that succeeded.
		if (!updated && !subscriber) {
			await log.error('skills.tagme.no.subscriber.returned', {
				formId: SKILLS_FORM_ID,
				via: identity.via,
			})
			return { success: false, reason: 'request-failed' as const }
		}

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
		await sendSkillsNewsletterPathEntry(subscribed, source)

		// From the PARSED record, not the cookie: on the session path there may be
		// no cookie record at all, and this is the id we actually enrolled.
		await log.info('skills.tagme.success', {
			subscriberId: subscribed.id,
			formId: SKILLS_FORM_ID,
			via: identity.via,
		})

		revalidatePath('/skills')

		return { success: true as const }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		await log.error('skills.tagme.failed', {
			subscriberId: subscriber?.id,
			formId: SKILLS_FORM_ID,
			via: identity.via,
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
