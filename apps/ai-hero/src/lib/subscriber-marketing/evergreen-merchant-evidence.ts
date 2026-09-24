import { and, eq, isNull } from 'drizzle-orm'

import { db } from '@/db'
import { merchantCoupon } from '@/db/schema'
import { createOrFindFixedMerchantCoupon } from '@/lib/coupons-query'

import {
	EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
	EVERGREEN_OFFER_CURRENCY,
} from './evergreen-offer-journey/domain'

/**
 * The Stripe-backed merchant coupon the evergreen offer redeems through:
 * the account's active, globally owned "special $100.00" fixed coupon.
 * Looked up with the authority's own constraints first (active, no
 * organization); only when none exists does the admin generator's helper
 * create one. A disabled or organization-owned twin is never accepted, and
 * the failure names it so an operator can fix the row instead of every
 * pending coupon refusing with `merchant-coupon-conflict`.
 */
export async function resolveEvergreenMerchantEvidence(): Promise<unknown> {
	const found = await findEvergreenMerchantEvidence()
	if (found) return found
	const created = await createOrFindFixedMerchantCoupon(
		EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
		false,
	)
	const evidence = await findEvergreenMerchantEvidence()
	if (!evidence) {
		throw new Error(
			`evergreen merchant coupon unavailable: ${
				created
					? `merchant coupon ${created} is disabled or organization-owned`
					: 'no special $100 merchant coupon could be created'
			}`,
		)
	}
	return evidence
}

/**
 * The same evidence, read-only: undefined when no active global coupon
 * exists. For callers that must never create a provider object (synthetic
 * test coupons).
 */
export async function findEvergreenMerchantEvidence(
	database: Pick<typeof db, 'select'> = db,
) {
	const [row] = await database
		.select()
		.from(merchantCoupon)
		.where(
			and(
				eq(merchantCoupon.amountDiscount, EVERGREEN_OFFER_AMOUNT_OFF_CENTS),
				eq(merchantCoupon.type, 'special'),
				eq(merchantCoupon.status, 1),
				isNull(merchantCoupon.organizationId),
			),
		)
		.limit(1)
	if (!row) return undefined
	return {
		id: row.id,
		identifier: row.identifier,
		merchantAccountId: row.merchantAccountId,
		currency: EVERGREEN_OFFER_CURRENCY,
		amountOffCents: EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
		type: 'special' as const,
		sourceReference: `merchantCoupon:${row.id}`,
	}
}
