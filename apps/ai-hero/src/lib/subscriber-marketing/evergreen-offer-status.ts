import type { IssuedCoupon } from './evergreen-offer-journey/domain'
import {
	readCouponEvidence,
	type CommerceCouponRow,
} from './evergreen-offer-journey/coupon-authority'
import type { EvergreenOfferStatus } from './evergreen-offer-notice'
import { formatOfferDeadline, offerDeadlineFromEvidence } from './offer-deadline'

export {
	evergreenOfferEndedText,
	isEvergreenCouponId,
	type EvergreenOfferStatus,
} from './evergreen-offer-notice'

/**
 * The deadline text for an issued coupon. With the absolute deadline format
 * on, its Kit field holds this same string (tested).
 */
export function issuedCouponDeadline(coupon: IssuedCoupon) {
	return formatOfferDeadline(
		offerDeadlineFromEvidence(coupon.expiresAt, coupon.deadlineTimeZone),
	)
}

export function evergreenOfferStatus(
	row: CommerceCouponRow | null,
	now: string,
): EvergreenOfferStatus {
	if (!row) return { status: 'none' }
	let coupon: IssuedCoupon
	try {
		coupon = readCouponEvidence(row).coupon
	} catch {
		// Not a journey-owned coupon, or its terms no longer match: say nothing.
		return { status: 'none' }
	}
	const nowMs = Date.parse(now)
	const expiresMs = Date.parse(coupon.expiresAt)
	// An unreadable clock says nothing rather than "ended".
	if (!Number.isFinite(nowMs) || !Number.isFinite(expiresMs))
		return { status: 'none' }
	if (nowMs < expiresMs) return { status: 'open' }
	return { status: 'ended', deadline: issuedCouponDeadline(coupon) }
}
