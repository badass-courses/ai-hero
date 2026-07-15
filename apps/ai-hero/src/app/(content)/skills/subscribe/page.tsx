import type { Metadata } from 'next'
import { CompanyLogoGrid } from '@/components/landing/company-logo-grid'
import LayoutClient from '@/components/layout-client'
import { getSubscriberFromCookie } from '@/lib/convertkit'

import { SkillsCourseFrontDoor } from '../_components/skills-course-front-door'
import { type SkillsNewsletterStatus } from '../_components/skills-newsletter'

export const metadata: Metadata = {
	title: 'AI Skills for Real Engineers — Free 7-Day Email Course',
	description:
		'A free seven-day email course for engineers building repeatable workflows with coding agents.',
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

export default async function SkillsSubscribePage() {
	const subscriber = await getSubscriberFromCookie()
	const status: SkillsNewsletterStatus = !subscriber
		? 'show-form'
		: subscriber.fields?.interest === 'skills'
			? 'subscribed'
			: 'tag-me'

	return (
		<LayoutClient withContainer>
			<SkillsCourseFrontDoor
				status={status}
				location="skills_course_front_door"
			/>
			<CompanyLogoGrid className="border-t pt-6" />
		</LayoutClient>
	)
}
