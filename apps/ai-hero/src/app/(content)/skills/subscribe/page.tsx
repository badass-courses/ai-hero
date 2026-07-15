import type { Metadata } from 'next'
import { CompanyLogoGrid } from '@/components/landing/company-logo-grid'
import LayoutClient from '@/components/layout-client'
import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { db } from '@/db'
import { getSubscriberFromCookie } from '@/lib/convertkit'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import { SubscriberSchema } from '@/schemas/subscriber'

import { SkillsCourseFrontDoor } from '../_components/skills-course-front-door'
import { type SkillsNewsletterStatus } from '../_components/skills-newsletter'
import { SubscriberUrlParam } from './subscriber-url-param'

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

async function resolveSubscriber(ckSubscriberId: string | undefined) {
	const fromCookie = await getSubscriberFromCookie()
	if (fromCookie) return fromCookie
	if (!ckSubscriberId || !/^\d+$/.test(ckSubscriberId)) return null
	try {
		const subscriber = await emailListProvider.getSubscriber(ckSubscriberId)
		return subscriber ? SubscriberSchema.parse(subscriber) : null
	} catch {
		return null
	}
}

async function hasCourseContact(email: string | undefined) {
	if (!email) return false
	try {
		const repository = new DrizzleCaptureMarketingRepository(db)
		const contact = await repository.findContactByEmail(
			email.trim().toLowerCase(),
		)
		return Boolean(contact)
	} catch {
		return false
	}
}

export default async function SkillsSubscribePage({
	searchParams,
}: {
	searchParams: Promise<{ ck_subscriber_id?: string }>
}) {
	const { ck_subscriber_id } = await searchParams
	const subscriber = await resolveSubscriber(ck_subscriber_id)
	// "Enrolled" means an app contact exists on the course paths — a Kit
	// interest field alone means they subscribed on the skills pages before the
	// course pipeline existed and still need one-click entry.
	const enrolled = subscriber
		? await hasCourseContact(subscriber.email_address ?? undefined)
		: false
	const status: SkillsNewsletterStatus = !subscriber
		? 'show-form'
		: enrolled
			? 'subscribed'
			: 'tag-me'

	return (
		<LayoutClient withContainer>
			<SubscriberUrlParam />
			<SkillsCourseFrontDoor
				status={status}
				location="skills_course_front_door"
			/>
			<CompanyLogoGrid className="border-t pt-6" />
		</LayoutClient>
	)
}
