export const INTEREST_FACT_REQUESTED_EVENT =
	'aihero/interest.fact.requested' as const

export type InterestFactRequested = {
	name: typeof INTEREST_FACT_REQUESTED_EVENT
	data: {
		email: string
		/** `waitlist_<product>` or `interest_<workshop>`. */
		fieldKey: string
		/** When the reader joined, ISO-8601. A backfill passes Kit's date. */
		expressedAt: string
		/** Which path recorded it, for logs only. */
		via: 'one-click' | 'form' | 'backfill'
	}
}
