import { evergreenJourneyIdForContact } from './drovr-evergreen-coupon'
import {
	CouponAuthorityFailure,
	readCouponEvidence,
	type CommerceCouponRow,
} from './evergreen-offer-journey/coupon-authority'
import type { EvergreenOfferRedemption } from './lifecycle-contact-events'

const EVERGREEN_COUPON_PREFIX = 'eoj-coupon:'

type PurchaseCouponColumns = {
	couponId?: string | null
	redeemedBulkCouponId?: string | null
	bulkCouponId?: string | null
}

/**
 * The evergreen coupon a purchase redeemed, if any. Checkout records a
 * single-use coupon on couponId; the bulk columns are read defensively so a
 * change in how checkout records it cannot silently drop the attribution.
 */
export function evergreenCouponIdOf(
	purchase: PurchaseCouponColumns,
): string | undefined {
	return [
		purchase.couponId,
		purchase.redeemedBulkCouponId,
		purchase.bulkCouponId,
	].find(
		(id): id is string =>
			typeof id === 'string' && id.startsWith(EVERGREEN_COUPON_PREFIX),
	)
}

/**
 * Until redemption is written back, a redeemed coupon id stays a working
 * checkout link until it expires. Logs carry only a prefix.
 */
export function evergreenCouponLogId(couponId: string) {
	return couponId.slice(0, EVERGREEN_COUPON_PREFIX.length + 12)
}

export type EvergreenOfferCouponRead =
	| { status: 'redeemed'; redemption: EvergreenOfferRedemption }
	| { status: 'refused'; couponId: string; reason: string }

/**
 * Reads which contact an evergreen coupon was issued to. The row must pass
 * the same structural checks as the coupon authority's history read, so a
 * coupon that merely carries the id prefix cannot redirect a purchase.
 */
export function readEvergreenOfferCoupon(
	couponId: string,
	row: CommerceCouponRow | null,
): EvergreenOfferCouponRead {
	if (!row) return { status: 'refused', couponId, reason: 'coupon-missing' }
	if (row.id !== couponId)
		return { status: 'refused', couponId, reason: 'coupon-id-mismatch' }
	try {
		const { coupon, issue } = readCouponEvidence(row)
		// The row id hashes the journey, and the journey is derived from the
		// contact: a contact that does not derive this journey is not the one
		// the coupon was issued to.
		if (issue.journeyId !== evergreenJourneyIdForContact(issue.contactId))
			return { status: 'refused', couponId, reason: 'coupon-contact-mismatch' }
		return {
			status: 'redeemed',
			redemption: { couponId: coupon.couponId, contactId: coupon.contactId },
		}
	} catch (error) {
		// Any failure falls back to the buyer's contact: recording the purchase
		// somewhere must never depend on the coupon row being well formed.
		return {
			status: 'refused',
			couponId,
			reason:
				error instanceof CouponAuthorityFailure
					? error.failure.reason
					: `coupon-read-failed: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
}
