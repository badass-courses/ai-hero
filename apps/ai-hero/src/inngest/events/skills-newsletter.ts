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
	}
}
