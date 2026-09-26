import {
	contactSyncCursor,
	valuePathLinkAnchor,
} from '@/db/contact-sync-schema'
import { contactEvent } from '@/db/schema'
import { isMysqlDuplicateEntryError } from '@/lib/mysql-primary-key-retry'
import { and, asc, eq, gt, isNull, lt, lte, or } from 'drizzle-orm'

import {
	linkRotationRanges,
	type ContactSyncReconcilePorts,
	type ScannedContactEvent,
} from './contact-sync-reconcile'

/** The one stream this reconcile covers: drovr's contact directory. */
export const CONTACT_SYNC_CURSOR_NAME = 'contact-directory'

type Database = {
	select: (fields: unknown) => {
		from: (table: unknown) => {
			where: (clause: unknown) => {
				limit: (n: number) => Promise<unknown[]>
				orderBy: (...order: unknown[]) => {
					limit: (n: number) => Promise<unknown[]>
				}
				groupBy: (...columns: unknown[]) => Promise<unknown[]>
			}
		}
	}
	insert: (table: unknown) => { values: (values: unknown) => Promise<unknown> }
	update: (table: unknown) => {
		set: (values: unknown) => { where: (clause: unknown) => Promise<unknown> }
	}
}

/**
 * The reconcile's reads and its cursor write, on MySQL. The scan rides
 * ContactEvent_occurredAt_idx (every event type, so no list can drift);
 * rotation rides ValuePathLinkAnchor_issuedAt_idx (DR #39).
 */
export function createDrizzleContactSyncStore(
	// The same shape the capture repository takes; this module only uses
	// select/insert/update.
	database: unknown,
): Pick<
	ContactSyncReconcilePorts,
	'readWatermark' | 'scanChanges' | 'rotatedContacts'
> & { writeWatermark(watermark: string, heartbeatAt: string): Promise<void> } {
	const db = database as Database
	const byName = eq(contactSyncCursor.name, CONTACT_SYNC_CURSOR_NAME)
	return {
		async readWatermark() {
			const rows = (await db
				.select({ watermark: contactSyncCursor.watermark })
				.from(contactSyncCursor)
				.where(byName)
				.limit(1)) as { watermark: string | null }[]
			const watermark = rows[0]?.watermark
			return watermark ? isoOf(watermark) : undefined
		},
		async scanChanges({ after, through, limit }) {
			const rows = (await db
				.select({
					id: contactEvent.id,
					contactId: contactEvent.contactId,
					eventType: contactEvent.eventType,
					occurredAt: contactEvent.occurredAt,
				})
				.from(contactEvent)
				.where(
					and(
						gt(contactEvent.occurredAt, new Date(after)),
						lte(contactEvent.occurredAt, new Date(through)),
					),
				)
				.orderBy(asc(contactEvent.occurredAt), asc(contactEvent.id))
				.limit(limit + 1)) as {
				id: string
				contactId: string
				eventType: string
				occurredAt: Date | string
			}[]
			return rows.map((row): ScannedContactEvent => ({
				id: row.id,
				contactId: row.contactId,
				eventType: row.eventType,
				occurredAt: isoOf(row.occurredAt),
			}))
		},
		async rotatedContacts(window) {
			const contacts = new Set<string>()
			for (const range of linkRotationRanges(window)) {
				const rows = (await db
					.select({ contactId: valuePathLinkAnchor.contactId })
					.from(valuePathLinkAnchor)
					.where(
						and(
							gt(valuePathLinkAnchor.issuedAt, sqlTimestamp(range.after)),
							lte(valuePathLinkAnchor.issuedAt, sqlTimestamp(range.through)),
						),
					)
					.groupBy(valuePathLinkAnchor.contactId)) as { contactId: string }[]
				for (const row of rows) contacts.add(row.contactId)
			}
			return [...contacts]
		},
		async writeWatermark(watermark, heartbeatAt) {
			const values = {
				cursor: watermark,
				watermark: sqlTimestamp(watermark),
				heartbeatAt: sqlTimestamp(heartbeatAt),
			}
			try {
				await db
					.insert(contactSyncCursor)
					.values({ name: CONTACT_SYNC_CURSOR_NAME, ...values })
				return
			} catch (error) {
				if (!isMysqlDuplicateEntryError(error)) throw error
			}
			// Forward only: a slower, older run never moves the cursor back.
			await db
				.update(contactSyncCursor)
				.set(values)
				.where(
					and(
						byName,
						or(
							isNull(contactSyncCursor.watermark),
							lt(contactSyncCursor.watermark, values.watermark),
						),
					),
				)
		},
	}
}

/** MySQL timestamp(3) in UTC: 'YYYY-MM-DD HH:MM:SS.mmm'. */
function sqlTimestamp(iso: string): string {
	return new Date(iso).toISOString().slice(0, 23).replace('T', ' ')
}

function isoOf(value: string | Date): string {
	if (value instanceof Date) return value.toISOString()
	return /(Z|[+-]\d{2}:?\d{2})$/.test(value)
		? new Date(value).toISOString()
		: new Date(`${value.replace(' ', 'T')}Z`).toISOString()
}
