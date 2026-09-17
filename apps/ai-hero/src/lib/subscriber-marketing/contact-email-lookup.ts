import { eq } from 'drizzle-orm'
import { contact } from '@/db/schema'
import type { EvergreenOfferJourneyDatabase } from './evergreen-offer-journey/drizzle-ledger'
import {
	emailEquivalenceKey,
	emailRawSourceDigest,
	isNormalizedEmail,
	normalizeEmail,
} from './contact-email-equivalence'

export type IndexedEmailContact = Readonly<{
	id: string
	email: string
	emailKey: string
	emailKeySource: string
}>

/** Transaction-scoped only: pass the caller's exclusive SERIALIZABLE connection
 * and retain it through subsequent User/session validation and evidence INSERT.
 * This function never acquires, commits or releases a connection. Query/schema
 * errors propagate; undefined means integrity/ambiguity/candidate failure.
 * No raw/normalized scan fallback and no repair. Do not log returned raw data. */
export async function lookupIndexedEmailContact(
	transaction: Pick<EvergreenOfferJourneyDatabase, 'select'>,
	email: string,
): Promise<IndexedEmailContact | undefined> {
	if (!isNormalizedEmail(email)) return undefined
	const normalized = normalizeEmail(email),
		expectedKey = emailEquivalenceKey(normalized)
	// First SQL statement locks global stale=1, including the empty range.
	const stale = await transaction
		.select({ id: contact.id })
		.from(contact)
		.where(eq(contact.emailKeyStale, 1))
		.limit(1)
		.for('update')
	if (stale.length !== 0) return undefined
	const candidates = await transaction
		.select({
			id: contact.id,
			email: contact.email,
			emailKey: contact.emailKey,
			emailKeySource: contact.emailKeySource,
		})
		.from(contact)
		.where(eq(contact.emailKey, expectedKey))
		.limit(2)
		.for('update')
	if (candidates.length !== 1) return undefined
	const owner = candidates[0]
	if (!owner || typeof owner.email !== 'string') return undefined
	const source = emailRawSourceDigest(owner.email)
	if (
		owner.emailKey !== expectedKey ||
		emailEquivalenceKey(owner.email) !== expectedKey ||
		owner.emailKeySource !== source ||
		normalizeEmail(owner.email) !== normalized
	)
		return undefined
	return {
		id: owner.id,
		email: owner.email,
		emailKey: expectedKey,
		emailKeySource: source,
	}
}
