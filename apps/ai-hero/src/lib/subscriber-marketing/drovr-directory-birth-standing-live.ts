import { contactEvent, providerIdentity } from '@/db/schema'
import { and, eq, inArray } from 'drizzle-orm'

import { AI_HERO_UNSUBSCRIBED_TAG_ID } from './ai-hero-email-opt-in'
import {
	activeContactStopsByKey,
	CONTACT_STOP_RULE_EVENT_TYPES,
	stopSignalOfEvent,
} from './contact-stop-rule'
import type {
	DirectoryBirthStandingReader,
	DirectoryBirthLifecycle,
} from './drovr-directory-birth-standing'
import {
	createKitReader,
	fetchKitSubscriberTagIds,
	type KitReader,
} from './signup-confirmation-kit-reader'

let kitReader: KitReader | undefined
function reader(): KitReader {
	if (!kitReader) {
		const key =
			process.env.CONVERTKIT_V4_API_KEY ?? process.env.CONVERTKIT_API_KEY
		if (!key) throw new Error('Directory birth standing requires a Kit API key')
		kitReader = createKitReader(key)
	}
	return kitReader
}

/** Batch local stop evidence, then check current Kit tags for linked contacts. No writes. */
export const readDirectoryBirthStanding: DirectoryBirthStandingReader = async (
	births,
) => {
	const { db } = await import('@/db')
	const ids = [...new Set(births.map((birth) => birth.contactId))]
	const [rows, identities] = await Promise.all([
		db
			.select({
				contactId: contactEvent.contactId,
				eventType: contactEvent.eventType,
				occurredAt: contactEvent.occurredAt,
			})
			.from(contactEvent)
			.where(
				and(
					inArray(contactEvent.contactId, ids),
					inArray(contactEvent.eventType, [...CONTACT_STOP_RULE_EVENT_TYPES]),
				),
			),
		db
			.select({
				contactId: providerIdentity.contactId,
				externalId: providerIdentity.externalId,
			})
			.from(providerIdentity)
			.where(
				and(
					eq(providerIdentity.provider, 'kit'),
					inArray(providerIdentity.contactId, ids),
				),
			),
	])
	const stops = activeContactStopsByKey(
		rows.map((row) => ({ key: row.contactId, signal: stopSignalOfEvent(row) })),
	)
	const standing = new Map<string, DirectoryBirthLifecycle>()
	for (const id of ids) {
		const stop = stops.get(id)
		if (stop?.bounced || stop?.complained) {
			standing.set(id, 'bounced')
			continue
		}
		if (stop?.unsubscribed) {
			standing.set(id, 'unsubscribed')
			continue
		}
		const payload = births.find((birth) => birth.contactId === id)?.payload as
			| { kitSubscriberId?: string }
			| undefined
		const kitIds = new Set(
			identities
				.filter((identity) => identity.contactId === id)
				.map((identity) => identity.externalId),
		)
		if (payload?.kitSubscriberId) kitIds.add(payload.kitSubscriberId)
		let tagged = false
		for (const kitId of kitIds) {
			const tags = await fetchKitSubscriberTagIds(reader(), kitId)
			// An unknown linked subscriber is uncertainty, not proof of consent.
			if (tags === 'not-found')
				throw new Error('Directory birth Kit subscriber not found')
			if (tags.has(AI_HERO_UNSUBSCRIBED_TAG_ID)) tagged = true
		}
		standing.set(id, tagged ? 'unsubscribed' : 'provisional')
	}
	return standing
}
