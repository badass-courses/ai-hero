import type { db as liveDatabase } from '@/db'
import { contactEvent } from '@/db/schema'
import { and, inArray } from 'drizzle-orm'

import { CONTACT_STOP_RULE_EVENT_TYPES } from './contact-stop-rule'
import { unsubscribedBirthContactIds } from './drovr-value-path-birth-admission'

/** One indexed local read per slice, no Kit calls. Recorded, liftable events only. */
export async function readUnsubscribedValuePathContactIds(
	contactIds: readonly string[],
	database?: Pick<typeof liveDatabase, 'select'>,
): Promise<string[]> {
	const ids = [...new Set(contactIds)]
	if (ids.length === 0) return []
	const db = database ?? (await import('@/db')).db
	const stopped: string[] = []
	for (let start = 0; start < ids.length; start += 500) {
		const rows = await db
			.select({
				contactId: contactEvent.contactId,
				eventType: contactEvent.eventType,
				occurredAt: contactEvent.occurredAt,
			})
			.from(contactEvent)
			.where(
				and(
					inArray(contactEvent.contactId, ids.slice(start, start + 500)),
					inArray(contactEvent.eventType, [...CONTACT_STOP_RULE_EVENT_TYPES]),
				),
			)
		// Directory state is a stale snapshot without a production lift path.
		// Tag-only changes and drovr unsubscribe intents have no event mirror;
		// they remain guarded by drovr's own suppression, not this admission.
		stopped.push(...unsubscribedBirthContactIds(rows))
	}
	return stopped
}
