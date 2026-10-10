/**
 * Whether a product sells team seats right now. One answer for both readers:
 * the team page (checkout and invoice, or a request) and the invoice action
 * (which re-reads the product and never trusts the page).
 *
 * The rules mirror the pages that already sell these products. A self-paced
 * workshop is on sale when published and public (`PublicWorkshopPricing`). A
 * cohort or live product is on sale when published and inside its enrollment
 * window (the cohort page's `CAN_ENROLL`). A limited product also needs room
 * for every seat.
 */

export type TeamSaleProduct = {
	id: string
	type?: string | null
	status: number
	quantityAvailable?: number | null
	fields?: {
		state?: string | null
		visibility?: string | null
		openEnrollment?: string | Date | null
		closeEnrollment?: string | Date | null
	} | null
}

export type TeamSaleState =
	| { onSale: true }
	| {
			onSale: false
			/**
			 * `upcoming` and `unpublished` can still take an invoice request;
			 * the rest are a plain no.
			 */
			reason:
				| 'unpublished'
				| 'upcoming'
				| 'closed'
				| 'sold-out'
				| 'not-team-product'
				| 'archived'
	  }

const TEAM_PRODUCT_TYPES = new Set(['self-paced', 'cohort', 'live'])
const ENROLLMENT_PRODUCT_TYPES = new Set(['cohort', 'live'])

const at = (value: string | Date | null | undefined) =>
	value ? new Date(value) : null

export function teamSaleState(
	product: TeamSaleProduct,
	options: { now: Date; purchaseCount: number; seats?: number },
): TeamSaleState {
	if (product.status !== 1) return { onSale: false, reason: 'archived' }
	const type = product.type ?? 'self-paced'
	if (!TEAM_PRODUCT_TYPES.has(type)) {
		return { onSale: false, reason: 'not-team-product' }
	}
	const fields = product.fields ?? {}
	if (fields.state !== 'published') {
		return { onSale: false, reason: 'unpublished' }
	}

	if (ENROLLMENT_PRODUCT_TYPES.has(type)) {
		const opens = at(fields.openEnrollment)
		const closes = at(fields.closeEnrollment)
		if (opens && opens > options.now) {
			return { onSale: false, reason: 'upcoming' }
		}
		if (closes && closes <= options.now) {
			return { onSale: false, reason: 'closed' }
		}
	} else if (fields.visibility !== 'public') {
		return { onSale: false, reason: 'unpublished' }
	}

	const limit = product.quantityAvailable ?? -1
	if (limit >= 0) {
		const remaining = limit - options.purchaseCount
		if (remaining < Math.max(1, options.seats ?? 1)) {
			return { onSale: false, reason: 'sold-out' }
		}
	}

	return { onSale: true }
}

/** Reasons the invoice form turns into a request to support. */
export const REQUESTABLE_REASONS: ReadonlySet<string> = new Set([
	'unpublished',
	'upcoming',
])
