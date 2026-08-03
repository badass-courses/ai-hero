import { cookies } from 'next/headers'
import { NextRequest } from 'next/server'
import { POST as courseBuilderPOST } from '@/coursebuilder/course-builder-config'
import {
	SKILLS_NEWSLETTER_SUBSCRIBED_EVENT,
	type SkillsNewsletterSubscribed,
} from '@/inngest/events/skills-newsletter'
import { inngest } from '@/inngest/inngest.server'
import { createShortlinkAttribution } from '@/lib/shortlinks-query'
import { reconcileAiHeroEmailOptInWithKit } from '@/lib/subscriber-marketing/ai-hero-email-opt-in.server'
import { parseOptInAttributionCookie } from '@/lib/subscriber-marketing/opt-in-attribution'
import { SubscriberSchema } from '@/schemas/subscriber'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'

/**
 * Custom wrapper for the subscribe-to-list endpoint that adds shortlink attribution tracking
 *
 * This route intercepts newsletter signups and records attribution if the user
 * came from a shortlink (identified by the sl_ref cookie)
 */
const subscribeWithAttribution = async (req: NextRequest) => {
	// Read the request body before passing to coursebuilder
	const body = await req.json()
	const email = body.email

	// Clone the request with the body since it can only be read once
	const clonedRequest = new NextRequest(req.url, {
		method: 'POST',
		headers: req.headers,
		body: JSON.stringify(body),
	})

	// Get the original response from coursebuilder
	const response = await courseBuilderPOST(clonedRequest)

	// Only track successful subscriptions (status 200).
	if (response.status === 200 && email) {
		if (Number(body.listId) === 9376133) {
			try {
				const subscriber = SubscriberSchema.parse(await response.clone().json())
				if (!subscriber.email_address) {
					throw new Error('Skills subscriber response is missing an email')
				}
				const optIn = await reconcileAiHeroEmailOptInWithKit({
					email: subscriber.email_address,
					subscriberState: subscriber.state,
				})
				if (optIn.status === 'confirmation-required') {
					await log.info('skills.newsletter.confirmation.required', {
						formId: 9376133,
						kitSubscriberId: String(subscriber.id),
					})
				} else {
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
							formId: 9376133,
							source: body.fields?.source ?? 'aihero_skills_page',
							subscribedAt: new Date().toISOString(),
							optInAttribution,
						},
					}
					await inngest.send(event)
				}
			} catch (error) {
				await log.error('skills.newsletter.path-entry.enqueue.failed', {
					formId: 9376133,
					error: error instanceof Error ? error.message : String(error),
				})
				throw error
			}
		}

		try {
			// Read the sl_ref cookie to get the shortlink slug
			const cookieStore = await cookies()
			const shortlinkSlug = cookieStore.get('sl_ref')?.value

			if (shortlinkSlug) {
				// Record attribution asynchronously (don't await to avoid slowing down response)
				createShortlinkAttribution({
					shortlinkSlug,
					email,
					type: 'signup',
				}).catch((error) => {
					void log.error('api.coursebuilder.subscribe.attribution.failed', {
						shortlinkSlug,
						email,
						error: error instanceof Error ? error.message : String(error),
					})
				})
			}
		} catch (error) {
			// Log error but don't fail the subscription
			await log.error('api.coursebuilder.subscribe.attribution.error', {
				email,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	return response
}

export const POST = withSkill(subscribeWithAttribution)
