export const NEWSLETTER_VETERANS_ASSIGN_EVENT =
	'newsletter/veterans.assign' as const

/** A contact drovr already owns for the course but not yet for the newsletter. */
export type NewsletterVeteran = {
	contactId: string
	kitSubscriberId: string
}

export type NewsletterVeteransAssign = {
	name: typeof NEWSLETTER_VETERANS_ASSIGN_EVENT
	data: {
		batch: NewsletterVeteran[]
		dryRun?: boolean
	}
}
