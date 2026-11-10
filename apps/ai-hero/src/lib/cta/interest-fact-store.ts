import { contact, contactEvent, providerIdentity } from '@/db/schema'
import { emailEquivalenceKey } from '@/lib/subscriber-marketing/contact-email-equivalence'
import { CONTACT_EVENT_SCHEMA_VERSION } from '@/lib/subscriber-marketing/types'
import { and, asc, eq } from 'drizzle-orm'

import {
	INTEREST_FACT_EVENT_TYPE,
	interestFieldsFromFacts,
	localInterestFactKey,
	localInterestFactReference,
	type InterestFieldKey,
} from './interest-facts'

/** The drizzle handle, structurally, so tests can pass a fake. */
export type InterestFactDatabase = { select: any; insert: any }

/**
 * The one local contact this address names. Two contacts on one email key is
 * an identity problem, not a join to guess at, so it answers none.
 */
export async function findContactIdForEmail(
	db: InterestFactDatabase,
	email: string,
): Promise<string | undefined> {
	const rows: { id: string }[] = await db
		.select({ id: contact.id })
		.from(contact)
		.where(eq(contact.emailKey, emailEquivalenceKey(email)))
		.limit(2)
	return rows.length === 1 ? rows[0]!.id : undefined
}

export type LocalInterestFactResult =
	| { status: 'inserted' | 'existing'; occurredAt: string }
	| { status: 'no-identity' }

/**
 * Record a join as a ContactEvent. Inserted directly rather than through the
 * capture repository: a join changes no contact state and is sent to drovr by
 * its own call, not the shadow dispatch. The semantic key keeps one row per
 * contact and list, and the first row's time is the join time.
 */
export async function writeLocalInterestFact(
	db: InterestFactDatabase,
	args: { contactId: string; fieldKey: InterestFieldKey; at: string },
): Promise<LocalInterestFactResult> {
	const key = localInterestFactKey(args.contactId, args.fieldKey)
	const existing = await findFact(db, key)
	if (existing) return { status: 'existing', occurredAt: existing }

	const identities: { id: string; provider: string }[] = await db
		.select({ id: providerIdentity.id, provider: providerIdentity.provider })
		.from(providerIdentity)
		.where(eq(providerIdentity.contactId, args.contactId))
		.orderBy(asc(providerIdentity.createdAt))
		.limit(10)
	const identity =
		identities.find((row) => row.provider === 'ai-hero') ?? identities[0]
	if (!identity) return { status: 'no-identity' }

	const occurredAt = new Date(args.at)
	try {
		await db.insert(contactEvent).values({
			contactId: args.contactId,
			providerIdentityId: identity.id,
			provider: 'ai-hero',
			providerEventId: `${INTEREST_FACT_EVENT_TYPE}:${args.fieldKey}`,
			providerReference: localInterestFactReference(args.fieldKey),
			eventType: INTEREST_FACT_EVENT_TYPE,
			semanticIdempotencyKey: key,
			privacyLevel: 'internal',
			identityEvidence: { source: 'ai-hero', strength: 'medium' },
			payloadSummary: {
				summary: `Joined ${args.fieldKey}`,
				keywords: [args.fieldKey],
				restrictedPayloadStored: false,
			},
			schemaVersion: CONTACT_EVENT_SCHEMA_VERSION,
			occurredAt,
		})
		return { status: 'inserted', occurredAt: occurredAt.toISOString() }
	} catch (cause) {
		// A concurrent join won the unique key; its row is the fact.
		const raced = await findFact(db, key)
		if (raced) return { status: 'existing', occurredAt: raced }
		throw cause
	}
}

/** `{ waitlist_x: '2026-10-29' }` for every list this contact joined. */
export async function readLocalInterestFields(
	db: InterestFactDatabase,
	contactId: string,
): Promise<Record<string, string>> {
	const rows: { providerReference: string; occurredAt: Date }[] = await db
		.select({
			providerReference: contactEvent.providerReference,
			occurredAt: contactEvent.occurredAt,
		})
		.from(contactEvent)
		.where(
			and(
				eq(contactEvent.eventType, INTEREST_FACT_EVENT_TYPE),
				eq(contactEvent.contactId, contactId),
			),
		)
		.limit(200)
	return interestFieldsFromFacts(rows)
}

async function findFact(db: InterestFactDatabase, key: string) {
	const rows: { occurredAt: Date }[] = await db
		.select({ occurredAt: contactEvent.occurredAt })
		.from(contactEvent)
		.where(eq(contactEvent.semanticIdempotencyKey, key))
		.limit(1)
	return rows[0] ? new Date(rows[0].occurredAt).toISOString() : undefined
}
