import { normalizeMarketingKey } from '@/lib/cta/conversion-intent'

/**
 * ConvertKit custom field key for "interested in this workshop" capture.
 *
 * We tag pre-launch interest with a per-workshop custom field rather than a CK
 * tag so it can be filtered in ConvertKit by "field is not empty". The value we
 * store is the ISO date the interest was expressed.
 *
 * CK field keys are lowercase alphanumeric + underscores only, so we coerce the
 * slug (which may contain hyphens) to match. Both the signup-form path and the
 * existing-subscriber server action must produce the same key.
 */
export function workshopInterestFieldKey(workshopSlug: string) {
	return `interest_${normalizeMarketingKey(workshopSlug)}`
}

/**
 * ConvertKit tag name for "interested in this workshop" (applied alongside the
 * custom field). Defined separately from `workshopInterestFieldKey` on purpose:
 * tag names are NOT bound by CK field-key character rules, so this must not
 * silently shift if the field-key normalization ever changes (which would
 * orphan every existing subscriber's tag). Identical string today by intent.
 */
export function workshopInterestTagName(workshopSlug: string) {
	return workshopInterestFieldKey(workshopSlug)
}
