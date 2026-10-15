import { RetryAfterError } from 'inngest'
import { BULK_EVENT_INTERVAL_MS } from './contact-sync-deltas'

/** Shared by the bulk lane, contact-sync retry and outbox replay. Use the
 * database clock and a conditional write, not a process-local timer or the
 * number of Inngest envelopes. An existing cursor table supplies the lock;
 * this adds a row, not a schema migration. Reservations are spent on failure
 * too. A crash can waste capacity, never permit an extra send.
 */
export async function reserveDrovrBulkSlot(): Promise<void> {
	const [{ db }, { sql }, { contactSyncCursor }] = await Promise.all([
		import('@/db'),
		import('drizzle-orm'),
		import('@/db/contact-sync-schema'),
	])
	const name = 'bulk-delivery-pace-v1'
	await db.execute(
		sql`INSERT IGNORE INTO ${contactSyncCursor} (\`name\`, \`cursor\`) VALUES (${name}, '0')`,
	)
	const result = await db.execute(
		sql`UPDATE ${contactSyncCursor} SET \`cursor\` = CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 + ${BULK_EVENT_INTERVAL_MS} AS UNSIGNED) WHERE ${contactSyncCursor.name} = ${name} AND CAST(${contactSyncCursor.cursor} AS UNSIGNED) <= UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000`,
	)
	const header = (Array.isArray(result) ? result[0] : result) as {
		affectedRows?: number
		rowsAffected?: number
	}
	if ((header?.affectedRows ?? header?.rowsAffected) !== 1)
		throw new RetryAfterError(
			'BulkPace: you requested a bulk send, and it failed because the shared delivery slot is occupied. Accepted: one event per paced slot. Fix: retry the same event unchanged. Debug: inspect the bulk lane retry receipt.',
			'1s',
		)
}
