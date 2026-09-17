import type { Metadata } from 'next'
import LayoutClient from '@/components/layout-client'
import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { getSubscriberFromCookie } from '@/lib/convertkit'
import { resolveSkillsCtaState } from '@/lib/skills-cta-state'
import { SubscriberSchema } from '@/schemas/subscriber'
import { getServerAuthSession } from '@/server/auth'

import { type SkillsNewsletterStatus } from '../_components/skills-newsletter'
import { SkillsSubscribeFrontDoor } from './_components/skills-subscribe-page'
import { SubscriberUrlParam } from './subscriber-url-param'

export const metadata: Metadata = {
	title: 'AI Skills for Real Engineers: Free Seven-Lesson Email Course',
	description:
		'A free seven-lesson email course for engineers building repeatable workflows with coding agents. Go as fast as you want.',
	alternates: {
		canonical: '/skills/subscribe',
	},
	openGraph: {
		images: [
			{
				url: 'https://res.cloudinary.com/total-typescript/image/upload/v1777381841/skills-og_2x.jpg',
			},
		],
	},
}

async function resolveSubscriber(ckSubscriberId: string | undefined) {
	const fromCookie = await getSubscriberFromCookie()
	if (fromCookie?.state === 'active') return fromCookie
	const subscriberId = fromCookie?.id?.toString() ?? ckSubscriberId
	if (!subscriberId || !/^\d+$/.test(subscriberId)) return fromCookie
	try {
		const subscriber = await emailListProvider.getSubscriber(subscriberId)
		return subscriber ? SubscriberSchema.parse(subscriber) : fromCookie
	} catch {
		return fromCookie
	}
}

export default async function SkillsSubscribePage({
	searchParams,
}: {
	searchParams: Promise<{ ck_subscriber_id?: string }>
}) {
	const { ck_subscriber_id } = await searchParams
	const [subscriber, auth] = await Promise.all([
		resolveSubscriber(ck_subscriber_id),
		getServerAuthSession().catch(() => null),
	])

	// Kit confirmation is enrollment. The hourly reconciler guarantees path
	// entry, so this page reassures instead of asking for a third click.
	//
	// Resolved through the SHARED resolver, so this page and the inline CTA
	// cannot answer differently for the same reader. It used to collapse to
	// `subscribed` vs `show-form` with no `tag-me`, which told every active AI
	// Hero subscriber they were already on the course — including the ones who
	// had never joined it, who were then offered no way to.
	const resolved = await resolveSkillsCtaState(
		subscriber?.email_address ?? auth?.session?.user?.email,
	)

	// `account` and `tag-me` are the same control here — one click, no fields.
	// The panel's own copy does not claim prior enrolment, so the distinction
	// that matters in the inline CTA's footnote does not arise on this page.
	const status: SkillsNewsletterStatus =
		resolved === 'subscribed'
			? 'subscribed'
			: resolved === 'fresh'
				? 'show-form'
				: 'tag-me'

	return (
		<LayoutClient withContainer>
			<SubscriberUrlParam />
			<SkillsSubscribeFrontDoor
				status={status}
				location="skills_course_front_door"
			/>
		</LayoutClient>
	)
}
