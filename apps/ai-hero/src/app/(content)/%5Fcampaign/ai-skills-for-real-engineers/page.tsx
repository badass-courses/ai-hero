import type { Metadata } from 'next'
import { SkillsCourseFrontDoor } from '@/app/(content)/skills/_components/skills-course-front-door'
import { type SkillsNewsletterStatus } from '@/app/(content)/skills/_components/skills-newsletter'
import LayoutClient from '@/components/layout-client'
import { resolveSkillsCtaState } from '@/lib/skills-cta-state'
import { getServerAuthSession } from '@/server/auth'

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
	// Unlike ordinary render-time gating, this front door must refresh Kit: the
	// learner-flow worker writes `aih_course_started_at` after the signup cookie
	// is saved. The shared resolver owns that asynchronous transition.
	const auth = await getServerAuthSession().catch(() => null)
	const ctaState = await resolveSkillsCtaState(auth?.session?.user?.email)
	const status: SkillsNewsletterStatus =
		ctaState === 'subscribed'
			? 'subscribed'
			: ctaState === 'fresh'
				? 'show-form'
				: 'tag-me'

	return (
		<LayoutClient withContainer withNavigation={false} withFooter={false}>
			<SkillsCourseFrontDoor
				status={status}
				location="campaign_ai_skills"
				surface="skills-campaign"
			/>
		</LayoutClient>
	)
}
