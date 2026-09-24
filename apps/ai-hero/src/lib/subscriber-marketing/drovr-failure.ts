import type { SideEffectIntent } from './types'

/** Stable, bounded failure vocabulary on both synchronous and async replies.
 * Never forward provider errors: they may contain a contact's address. */
export function drovrFailureReasonClass(row: SideEffectIntent): string {
	const candidate = row.reviewReasons.at(-1)?.toLowerCase()
	// Review reasons can include dynamic text. Only known fixed classes cross
	// the boundary; no Kit error body, address or resource id can leak.
	return candidate && /^(?:coupon-(?:effectpermanentrefusal|effectambiguous|effecttransientunavailable|offer-payload-invalid|intent-invalid)|kit-(?:\d{3}|subscriber-missing|sequence-missing)|contact-email-missing|evergreen-(?:coupon-fields-exhausted|send-exhausted)|kit-sequence-enrollment-failed)$/.test(candidate)
		? candidate
		: 'executor-failed'
}

export function drovrFailureReason(row: SideEffectIntent): {
	reasonClass: string
	reason: string
} {
	const reasonClass = drovrFailureReasonClass(row)
	return { reasonClass, reason: reasonClass }
}
