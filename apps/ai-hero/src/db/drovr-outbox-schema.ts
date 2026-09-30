import { mysqlTable } from '@/db/mysql-table'
import {
	boolean,
	index,
	int,
	json,
	timestamp,
	uniqueIndex,
	varchar,
} from 'drizzle-orm/mysql-core'

/**
 * Row 204 (2026-09-30): a drovr send that ran out of retries lands here
 * instead of being lost, and drovr-outbox-replay re-posts it by its drovr
 * idempotency key until drovr answers 2xx (drovr dedupes a repeat).
 *
 * Additive and optional: an absent table makes the outbox write log
 * `drovr.outbox.unavailable` and the caller keep its previous behaviour.
 */
export const drovrOutbox = mysqlTable(
	'DrovrOutbox',
	{
		id: varchar('id', { length: 255 }).notNull().primaryKey(),
		/**
		 * sha256 of (target, endpoint, tenantId, contactId, journeyId,
		 * idempotencyKey): one row per send, so a second capture is a no-op.
		 */
		dedupeKey: varchar('dedupeKey', { length: 64 }).notNull(),
		/**
		 * The drovr origin plus VERCEL_ENV. Previews share this database, so
		 * a replay only ever takes rows for its own target.
		 */
		target: varchar('target', { length: 255 }).notNull(),
		/** `events` (POST /events) or `signups` (POST /signups). */
		endpoint: varchar('endpoint', { length: 20 }).notNull(),
		tenantId: varchar('tenantId', { length: 100 }).notNull(),
		contactId: varchar('contactId', { length: 255 }).notNull(),
		journeyId: varchar('journeyId', { length: 100 }).notNull(),
		eventType: varchar('eventType', { length: 100 }).notNull(),
		idempotencyKey: varchar('idempotencyKey', { length: 500 }).notNull(),
		/**
		 * The exact request body. Inline, not a reference: ContactEvent does
		 * not keep domainPayload, so a coupon or zone payload could not be
		 * rebuilt later. It can hold contact data, hence the 7 day deletion
		 * of delivered rows.
		 */
		body: json('body').notNull(),
		/** Captured before the owner fan-out: replay sends it back through it. */
		needsFanOut: boolean('needsFanOut').notNull().default(false),
		/** live | bulk | signup | fallback | onFailure | contactSync */
		source: varchar('source', { length: 20 }).notNull(),
		/** pending | delivered | rejected | held */
		status: varchar('status', { length: 20 }).notNull(),
		attempts: int('attempts').notNull().default(0),
		lastStatus: int('lastStatus'),
		lastError: varchar('lastError', { length: 1000 }),
		occurredAt: timestamp('occurredAt', { mode: 'string', fsp: 3 }).notNull(),
		firstFailedAt: timestamp('firstFailedAt', {
			mode: 'string',
			fsp: 3,
		}).notNull(),
		nextAttemptAt: timestamp('nextAttemptAt', {
			mode: 'string',
			fsp: 3,
		}).notNull(),
		lastAttemptAt: timestamp('lastAttemptAt', { mode: 'string', fsp: 3 }),
		deliveredAt: timestamp('deliveredAt', { mode: 'string', fsp: 3 }),
		/**
		 * A human released a held row (older than 24 hours): the replay then
		 * posts it despite its age.
		 */
		releasedAt: timestamp('releasedAt', { mode: 'string', fsp: 3 }),
		createdAt: timestamp('createdAt', { mode: 'string', fsp: 3 }).notNull(),
	},
	(table) => ({
		dedupeUq: uniqueIndex('DrovrOutbox_dedupe_uq').on(table.dedupeKey),
		dueIdx: index('DrovrOutbox_due_idx').on(
			table.status,
			table.target,
			table.nextAttemptAt,
		),
		deliveredIdx: index('DrovrOutbox_delivered_idx').on(
			table.status,
			table.deliveredAt,
		),
	}),
)
