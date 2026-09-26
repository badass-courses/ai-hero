import { contactEvent } from '@/db/schema'
import { and, asc, eq, gt, or } from 'drizzle-orm'

import type { BackfillPorts, BackfillRow } from './contact-sync-backfill'

/**
 * The backfill's page read: ContactEvents of one type after the cursor's
 * (occurredAt, id), in that order, on ContactEvent_eventType_occurredAt_id_idx.
 * The id breaks ties inside one second, so a page boundary never skips or
 * repeats a row.
 */
export function createDrizzleBackfillScan(
	// The same shape the capture repository takes; this only selects.
	database: unknown,
): BackfillPorts['scanEvents'] {
	const db = database as {
		select: (fields: unknown) => {
			from: (table: unknown) => {
				where: (clause: unknown) => {
					orderBy: (...order: unknown[]) => {
						limit: (n: number) => Promise<unknown[]>
					}
				}
			}
		}
	}
	return async ({ eventType, afterOccurredAt, afterId, limit }) => {
		const after = afterOccurredAt ? new Date(afterOccurredAt) : undefined
		const rows = (await db
			.select({
				id: contactEvent.id,
				contactId: contactEvent.contactId,
				eventType: contactEvent.eventType,
				providerEventId: contactEvent.providerEventId,
				occurredAt: contactEvent.occurredAt,
			})
			.from(contactEvent)
			.where(
				and(
					eq(contactEvent.eventType, eventType),
					after
						? or(
								gt(contactEvent.occurredAt, after),
								and(
									eq(contactEvent.occurredAt, after),
									gt(contactEvent.id, afterId ?? ''),
								),
							)
						: undefined,
				),
			)
			.orderBy(asc(contactEvent.occurredAt), asc(contactEvent.id))
			.limit(limit)) as (Omit<BackfillRow, 'occurredAt'> & {
			occurredAt: Date | string
		})[]
		return rows.map((row) => ({
			...row,
			occurredAt:
				row.occurredAt instanceof Date
					? row.occurredAt.toISOString()
					: new Date(`${row.occurredAt.replace(' ', 'T')}Z`).toISOString(),
		}))
	}
}
