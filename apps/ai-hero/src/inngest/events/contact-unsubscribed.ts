export const CONTACT_UNSUBSCRIBED_EVENT =
	'email-preferences/contact-unsubscribed' as const

export type ContactUnsubscribed = {
	name: typeof CONTACT_UNSUBSCRIBED_EVENT
	data: {
		idempotencyKey?: string
		email: string
		kitSubscriberId?: string
		preferenceKey: string
		source: string
		occurredAt: string
	}
}
