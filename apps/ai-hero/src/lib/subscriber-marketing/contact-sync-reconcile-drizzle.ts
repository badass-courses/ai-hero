import {
	contactSyncCursor,
	valuePathLinkAnchor,
} from '@/db/contact-sync-schema'
import { contactEvent } from '@/db/schema'
import { isMysqlDuplicateEntryError } from '@/lib/mysql-primary-key-retry'
import { and, asc, eq, gt, gte, isNull, lte, min, or, sql } from 'drizzle-orm'

import { VALUE_PATH_LINK_REISSUE_EVERY_DAYS } from './value-path-link-anchor'
import {
	linkRotationRanges,
	type ContactSyncReconcilePorts,
	type ScannedContactEvent,
	type ReconcileProgress,
} from './contact-sync-reconcile'

const ROTATION_STEP_MS =
	VALUE_PATH_LINK_REISSUE_EVERY_DAYS * 24 * 60 * 60 * 1000

/** The one stream this reconcile covers: drovr's contact directory. */
export const CONTACT_SYNC_CURSOR_NAME = 'contact-directory'

type GroupedQuery = { orderBy: (...order: unknown[]) => Promise<unknown[]> & { limit: (n: number) => Promise<unknown[]> }; having: (clause: unknown) => GroupedQuery }
type Database = {
	select: (fields: unknown) => {
		from: (table: unknown) => {
			where: (clause: unknown) => {
				limit: (n: number) => Promise<unknown[]>
				orderBy: (...order: unknown[]) => {
					limit: (n: number) => Promise<unknown[]>
				}
				groupBy: (...columns: unknown[]) => GroupedQuery
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
	'readWatermark' | 'readProgress' | 'scanChanges' | 'rotatedContacts'
> & { writeWatermark(watermark: string, heartbeatAt: string, progress?: ReconcileProgress): Promise<void> } {
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
		async readProgress() {
			const [row] = await db.select({ cursor: contactSyncCursor.cursor }).from(contactSyncCursor).where(byName).limit(1) as { cursor: string | null }[]
			return row?.cursor?.startsWith('{') ? JSON.parse(row.cursor) as ReconcileProgress : undefined
		},
		async scanChanges({ after, through, limit, writtenAfter, writtenThrough, pageAfter }) {
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
						writtenThrough ? lte(contactEvent.createdAt, new Date(writtenThrough)) : undefined,
						pageAfter ? or(gt(contactEvent.occurredAt, new Date(pageAfter.at)), and(eq(contactEvent.occurredAt, new Date(pageAfter.at)), gt(sql`BINARY ${contactEvent.id}`, pageAfter.id))) : undefined,
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
				.orderBy(asc(contactEvent.occurredAt), asc(sql`BINARY ${contactEvent.id}`))
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
		async rotatedContacts({ after, through, limit, pageAfter }) {
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
			// Earliest step per contact, across the ranges, in time order. An
			// overflowing range is re-read through its boundary instant with no
			// limit, so a tie (a batch issued at one instant) comes back whole:
			// cutting inside one would keep the reconcile from ever advancing.
			const steps = new Map<string, number>()
			const firstIssues = (
				range: { after: string; through: string },
				cap: number,
				stepMs: number,
			) => {
				let grouped = db
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
				if (pageAfter) {
					const cutoff = sqlTimestamp(new Date(Date.parse(pageAfter.at) - stepMs).toISOString())
					grouped = grouped.having(or(gt(min(valuePathLinkAnchor.issuedAt), cutoff), and(eq(min(valuePathLinkAnchor.issuedAt), cutoff), gt(sql`BINARY ${valuePathLinkAnchor.contactId}`, pageAfter.id))))
				}
				const query = grouped.orderBy(min(valuePathLinkAnchor.issuedAt), asc(sql`BINARY ${valuePathLinkAnchor.contactId}`))
				return query.limit(cap) as Promise<
					{ contactId: string; firstIssue: string }[]
				>
			}
			for (const [index, range] of linkRotationRanges(
				{ after, through },
				stepCount,
			).entries()) {
				const stepMs = (index + 1) * ROTATION_STEP_MS
				const rows = await firstIssues(range, limit + 1, stepMs)
				for (const row of rows) {
					const at = Date.parse(isoOf(row.firstIssue)) + stepMs
					const known = steps.get(row.contactId)
					if (known === undefined || at < known) steps.set(row.contactId, at)
				}
			}
			const ordered = [...steps].sort((left, right) => left[1] - right[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
			// Bounded even inside a dense tie; the persisted tuple resumes it.
			return ordered
				.slice(0, limit + 1)
				.map(([contactId, at]) => ({
					contactId,
					at: new Date(at).toISOString(),
				}))
		},
		async writeWatermark(watermark, heartbeatAt, progress) {
			const values = {
				cursor: progress ? JSON.stringify(progress) : watermark,
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
							lte(contactSyncCursor.watermark, values.watermark),
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
