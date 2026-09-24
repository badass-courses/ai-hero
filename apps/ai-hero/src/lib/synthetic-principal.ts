/**
 * Synthetic test principals (drovr #36T, T3) carry their marker in their
 * keys: contact and user ids start with `synthetic_`, and the address sits
 * on a reserved, undeliverable `.invalid` domain. Every exclusion (drovr
 * events, answer persistence, Kit, analytics, Stripe) is then a pure check
 * with nothing to look up, so it cannot fail open when a read fails.
 */
export const SYNTHETIC_PRINCIPAL_ID_PREFIX = 'synthetic_'
export const SYNTHETIC_PRINCIPAL_EMAIL_DOMAIN = 'synthetic.aihero.invalid'
/** SQL LIKE pattern for a synthetic id; `_` is a LIKE wildcard, so escaped. */
export const SYNTHETIC_PRINCIPAL_ID_LIKE = 'synthetic\\_%'

/**
 * True for a contact or user id minted for a synthetic principal.
 *
 * @example isSyntheticPrincipalId('synthetic_run-1') // true
 */
export function isSyntheticPrincipalId(id: string | null | undefined): boolean {
	return typeof id === 'string' && id.startsWith(SYNTHETIC_PRINCIPAL_ID_PREFIX)
}

/**
 * True for an address on the synthetic principal domain, in any case.
 *
 * @example isSyntheticPrincipalEmail('run-1@synthetic.aihero.invalid') // true
 */
export function isSyntheticPrincipalEmail(
	email: string | null | undefined,
): boolean {
	return (
		typeof email === 'string' &&
		email
			.trim()
			.toLowerCase()
			.endsWith(`@${SYNTHETIC_PRINCIPAL_EMAIL_DOMAIN}`)
	)
}

/**
 * Drops records about synthetic principals and counts them, for any record
 * keyed by a contact id (drovr events, audience rows).
 *
 * @example withoutSyntheticContacts([{ contactId: 'synthetic_a' }]) // { kept: [], discarded: 1 }
 */
export function withoutSyntheticContacts<T extends { contactId: string }>(
	records: readonly T[],
): { kept: T[]; discarded: number } {
	const kept = records.filter((record) => !isSyntheticPrincipalId(record.contactId))
	return { kept, discarded: records.length - kept.length }
}

/**
 * Real user ids only: drops nulls and synthetic principals, so a count built
 * from them shares the scope of user counts that exclude synthetic ids.
 *
 * @example realUserIds(['u1', null, 'synthetic_a']) // ['u1']
 */
export function realUserIds(ids: readonly (string | null | undefined)[]): string[] {
	return ids.filter(
		(id): id is string => typeof id === 'string' && !isSyntheticPrincipalId(id),
	)
}
