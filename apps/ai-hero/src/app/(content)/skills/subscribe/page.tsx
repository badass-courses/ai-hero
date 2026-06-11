import type { Metadata } from 'next'
import { CompanyLogoGrid } from '@/components/landing/company-logo-grid'
import LayoutClient from '@/components/layout-client'
import { getSubscriberFromCookie } from '@/lib/convertkit'

import * as SkillsNewsletter from '../_components/skills-newsletter'
import { type SkillsNewsletterStatus } from '../_components/skills-newsletter'

export const metadata: Metadata = {
	title: 'Skills Newsletter',
	description:
		'A practical skill system for engineers who want to use AI without giving up their standards.',
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
		<LayoutClient withContainer className="">
			<main className="flex min-h-[calc(100vh-var(--nav-height))] items-center justify-center pb-24 pt-5">
				<SkillsNewsletter.Root status={status} location="skills_subscribe">
					<div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-8 px-8 sm:px-16">
						<SkillsNewsletter.Image className="sm:w-40" />
						<div className="mb-2 flex flex-col gap-3 text-center font-normal">
							<h1 className="leading-tighter text-4xl font-medium tracking-tight sm:text-5xl">
								AI Skills for Real Engineers
							</h1>
							<h2 className="text-xl font-normal leading-tight opacity-90">
								A practical skill system for engineers who want to use AI
								without giving up their standards.
							</h2>
						</div>
						<div className="flex w-full flex-col gap-3">
							{status === 'tag-me' ? (
								<SkillsNewsletter.TagMeButton className="bg-primary mx-auto w-full max-w-sm" />
							) : (
								<SkillsNewsletter.Form
									label="Get the /skills"
									className="[&_button]:bg-primary mx-auto flex max-w-sm flex-col gap-5 [&_label]:mb-2 [&_label]:block"
								/>
							)}
							<SkillsNewsletter.Privacy className="mt-5 text-xs sm:text-sm" />
						</div>
					</div>
				</SkillsNewsletter.Root>
			</main>
			<CompanyLogoGrid />
		</LayoutClient>
	)
}
