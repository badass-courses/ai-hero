import type { Metadata } from 'next'
import { SkillsCourseFrontDoor } from '@/app/(content)/skills/_components/skills-course-front-door'
import { type SkillsNewsletterStatus } from '@/app/(content)/skills/_components/skills-newsletter'
import LayoutClient from '@/components/layout-client'
import { getSubscriberFromCookie } from '@/lib/convertkit'

export const metadata: Metadata = {
	title: 'AI Skills for Real Engineers — Free 7-Lesson Course',
	description:
		'A free seven-lesson course for engineers building repeatable workflows with coding agents. Go as fast as you want.',
	robots: {
		index: false,
		follow: false,
	},
}

export default async function AiSkillsCampaignPage() {
	const subscriber = await getSubscriberFromCookie()
	const status: SkillsNewsletterStatus = !subscriber
		? 'show-form'
		: subscriber.fields?.interest === 'skills'
			? 'subscribed'
			: 'tag-me'

	return (
		<LayoutClient withContainer withNavigation={false} withFooter={false}>
			<SkillsCourseFrontDoor status={status} location="campaign_ai_skills" />
		</LayoutClient>
	)
}
