import { toSnakeCase } from 'drizzle-orm/casing'

/**
 * ConvertKit custom field key for a cohort waitlist signup, e.g.
 * `waitlist_mcp_workshop_ticket`. The stored value is the ISO date the visitor
 * joined the waitlist. Set by the subscribe form on the cohort pricing widget.
 */
export function cohortWaitlistFieldKey(productName: string) {
	return `waitlist_${toSnakeCase(productName)}`
}

/**
 * ConvertKit tag name applied alongside the waitlist field. Mirrors
 * `cohortWaitlistFieldKey` by intent so the tag and field stay in lockstep,
 * but kept as its own function so the tag name has a stable definition that
 * won't silently shift if the field-key derivation ever changes (which would
 * orphan every existing subscriber's tag).
 */
export function cohortWaitlistTagName(productName: string) {
	return `waitlist_${toSnakeCase(productName)}`
}
