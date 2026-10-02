export const NEWSLETTER_EXIT_CONFIRMED_EVENT =
	'newsletter/old-sequence.exit-confirmed' as const

/** The proof producer persists the receipt first, then reliably sends this
 * wakeup. Neither a tag-added webhook nor this event itself is exit proof. */
export type NewsletterExitConfirmed = {
	name: typeof NEWSLETTER_EXIT_CONFIRMED_EVENT
	data: { contactId: string; receiptId: string }
}
