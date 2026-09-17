import { and, eq } from 'drizzle-orm'

import { db } from '@/db'
import { merchantCoupon } from '@/db/schema'
import { createOrFindFixedMerchantCoupon } from '@/lib/coupons-query'

import {
	EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
	EVERGREEN_OFFER_CURRENCY,
} from './evergreen-offer-journey/domain'

/**
 * The Stripe-backed merchant coupon the evergreen offer redeems through:
 * the account's existing "special $100.00" fixed coupon, created once via the
 * same helper the admin coupon generator uses if it does not exist yet.
 * Returned in the shape `merchantEvidenceSchema` expects.
 */
export async function resolveEvergreenMerchantEvidence(): Promise<unknown> {
	const id = await createOrFindFixedMerchantCoupon(
		EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
		false,
	)
	if (!id) throw new Error('evergreen merchant coupon unavailable')
	const [row] = await db
		.select()
		.from(merchantCoupon)
		.where(and(eq(merchantCoupon.id, id), eq(merchantCoupon.status, 1)))
		.limit(1)
	if (!row) throw new Error(`merchant coupon ${id} not readable`)
	return {
		id: row.id,
		identifier: row.identifier,
		merchantAccountId: row.merchantAccountId,
		currency: EVERGREEN_OFFER_CURRENCY,
		amountOffCents: EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
		type: 'special',
		sourceReference: `merchantCoupon:${row.id}`,
	}
}
