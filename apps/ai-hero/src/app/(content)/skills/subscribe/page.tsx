import type { Metadata } from 'next'
import LayoutClient from '@/components/layout-client'
import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { getSubscriberFromCookie } from '@/lib/convertkit'
import { SubscriberSchema } from '@/schemas/subscriber'

import { type SkillsNewsletterStatus } from '../_components/skills-newsletter'
import { SkillsSubscribeFrontDoor } from './_components/skills-subscribe-page'
import { SubscriberUrlParam } from './subscriber-url-param'

export const metadata: Metadata = {
	title: 'AI Skills for Real Engineers — Free 7-Lesson Course',
	description:
		'A free seven-lesson course for engineers building repeatable workflows with coding agents. Go as fast as you want.',
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
	const subscriber = await resolveSubscriber(ck_subscriber_id)
	// Kit confirmation is enrollment. The hourly reconciler guarantees path
	// entry, so this page reassures instead of asking for a third click.
	const status: SkillsNewsletterStatus =
		subscriber?.state === 'active' ? 'subscribed' : 'show-form'

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
