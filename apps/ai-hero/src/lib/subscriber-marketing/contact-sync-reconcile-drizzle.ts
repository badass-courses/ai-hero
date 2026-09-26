import {
	contactSyncCursor,
	valuePathLinkAnchor,
} from '@/db/contact-sync-schema'
import { contactEvent } from '@/db/schema'
import { isMysqlDuplicateEntryError } from '@/lib/mysql-primary-key-retry'
import { and, asc, eq, gt, gte, isNull, lt, lte, min, or } from 'drizzle-orm'

import { VALUE_PATH_LINK_REISSUE_EVERY_DAYS } from './value-path-link-anchor'
import {
	linkRotationRanges,
	type ContactSyncReconcilePorts,
	type ScannedContactEvent,
} from './contact-sync-reconcile'

const ROTATION_STEP_MS =
	VALUE_PATH_LINK_REISSUE_EVERY_DAYS * 24 * 60 * 60 * 1000

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
				groupBy: (...columns: unknown[]) => {
					orderBy: (...order: unknown[]) => {
						limit: (n: number) => Promise<unknown[]>
					}
				}
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
		async scanChanges({ after, through, limit, writtenAfter }) {
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
						// Late writes only: the occurredAt range keeps the index;
						// createdAt narrows it to rows the last run could not see.
						// createdAt is whole seconds, so the watermark's own second
						// counts too (a repeat re-sends the same version and key).
						writtenAfter
							? gte(
									contactEvent.createdAt,
									new Date(Math.floor(Date.parse(writtenAfter) / 1000) * 1000),
								)
							: undefined,
					),
				)
				.orderBy(asc(contactEvent.occurredAt), asc(contactEvent.id))
				.limit(limit + 1)) as {
				id: string
				contactId: string
				eventType: string
				occurredAt: Date | string
			}[]
			return rows.map(
				(row): ScannedContactEvent => ({
					id: row.id,
					contactId: row.contactId,
					eventType: row.eventType,
					occurredAt: isoOf(row.occurredAt),
				}),
			)
		},
		async rotatedContacts({ after, through, limit }) {
			// As many 90-day steps as the oldest anchor needs: no fixed cap.
			const [oldest] = (await db
				.select({ firstIssue: min(valuePathLinkAnchor.issuedAt) })
				.from(valuePathLinkAnchor)
				.where(lte(valuePathLinkAnchor.issuedAt, sqlTimestamp(through)))
				.limit(1)) as { firstIssue: string | null }[]
			if (!oldest?.firstIssue) return []
			const stepCount = Math.ceil(
				(Date.parse(through) - Date.parse(isoOf(oldest.firstIssue))) /
					ROTATION_STEP_MS,
			)
			if (stepCount < 1) return []
			// Earliest step per contact, across the ranges, in time order.
			const steps = new Map<string, number>()
			for (const [index, range] of linkRotationRanges(
				{ after, through },
				stepCount,
			).entries()) {
				const stepMs = (index + 1) * ROTATION_STEP_MS
				const rows = (await db
					.select({
						contactId: valuePathLinkAnchor.contactId,
						firstIssue: min(valuePathLinkAnchor.issuedAt),
					})
					.from(valuePathLinkAnchor)
					.where(
						and(
							gt(valuePathLinkAnchor.issuedAt, sqlTimestamp(range.after)),
							lte(valuePathLinkAnchor.issuedAt, sqlTimestamp(range.through)),
						),
					)
					.groupBy(valuePathLinkAnchor.contactId)
					.orderBy(min(valuePathLinkAnchor.issuedAt))
					.limit(limit + 1)) as { contactId: string; firstIssue: string }[]
				for (const row of rows) {
					const at = Date.parse(isoOf(row.firstIssue)) + stepMs
					const known = steps.get(row.contactId)
					if (known === undefined || at < known) steps.set(row.contactId, at)
				}
			}
			return [...steps]
				.sort((left, right) => left[1] - right[1])
				.slice(0, limit + 1)
				.map(([contactId, at]) => ({
					contactId,
					at: new Date(at).toISOString(),
				}))
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
