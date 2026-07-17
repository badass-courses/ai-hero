import type { OptInAttribution } from '@/lib/subscriber-marketing/opt-in-attribution'

export const SKILLS_NEWSLETTER_SUBSCRIBED_EVENT =
	'skills-newsletter/subscribed' as const

export type SkillsNewsletterSubscribed = {
	name: typeof SKILLS_NEWSLETTER_SUBSCRIBED_EVENT
	data: {
		kitSubscriberId: string
		email: string
		name?: string
		formId: number
		source: string
		subscribedAt: string
		signupGapLiveness?: {
			workSeen: number
			workDone: number
			oldestUnservedAgeHours: number | null
			oldestUnservedAt: string | null
		}
		optInAttribution?: OptInAttribution
	}
}
