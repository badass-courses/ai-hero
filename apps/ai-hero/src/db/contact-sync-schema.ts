import { mysqlTable } from '@/db/mysql-table'
import { bigint, timestamp, uniqueIndex, varchar } from 'drizzle-orm/mysql-core'

/**
 * Contact sync (2026-09-26): drovr keeps a synced contact profile instead of
 * calling ai-hero's personalize endpoint on every PostShiba send.
 *
 * Additive tables only. Nothing here changes an existing table, and the app
 * treats every one of them as optional: if the table is absent the caller
 * keeps its previous behaviour (see resolveValuePathLinkAnchor).
 */

/**
 * When a (contact, value path, email, inputs) answer-URL token was first
 * issued. The token then expires 120 days after that instant, so the URL
 * stays the same across sends and retries until an input changes.
 */
export const valuePathLinkAnchor = mysqlTable(
	'ValuePathLinkAnchor',
	{
		/**
		 * One digest of (contactId, valuePathSlug, emailResourceId,
		 * fingerprint). The four columns together exceed MySQL's 3072-byte
		 * unique-index limit, so they stay readable data and this carries
		 * the uniqueness (valuePathLinkAnchorRowKey).
		 */
		anchorKey: varchar('anchorKey', { length: 64 }).notNull(),
		contactId: varchar('contactId', { length: 255 }).notNull(),
		valuePathSlug: varchar('valuePathSlug', { length: 255 }).notNull(),
		emailResourceId: varchar('emailResourceId', { length: 255 }).notNull(),
		/** Digest of the inputs that shape the URLs; a change re-anchors. */
		fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
		issuedAt: timestamp('issuedAt', { mode: 'string', fsp: 3 }).notNull(),
		expiresAt: timestamp('expiresAt', { mode: 'string', fsp: 3 }).notNull(),
	},
	(table) => ({
		anchorUq: uniqueIndex('ValuePathLinkAnchor_anchor_uq').on(table.anchorKey),
	}),
)

/**
 * A per-contact counter, bumped once per profile sync (contact-profile-version).
 * drovr keeps the highest version it has seen, per contact.
 */
export const contactProfileVersion = mysqlTable('ContactProfileVersion', {
	contactId: varchar('contactId', { length: 255 }).notNull().primaryKey(),
	profileVersion: bigint('profileVersion', { mode: 'number', unsigned: true })
		.notNull()
		.default(1),
	/** sha256 of the content last pushed at this version (contactProfileContentHash). */
	profileHash: varchar('profileHash', { length: 64 }),
	updatedAt: timestamp('updatedAt', { mode: 'string', fsp: 3 })
		.notNull()
		.defaultNow()
		.onUpdateNow(),
})

/**
 * The contact-sync reconcile's cursor, one row per stream: `watermark` is
 * the last instant every contact change up to which drovr acknowledged
 * (the heartbeat's syncedThrough), `heartbeatAt` when it was sent. The
 * row only moves forward.
 */
export const contactSyncCursor = mysqlTable('ContactSyncCursor', {
	name: varchar('name', { length: 255 }).notNull().primaryKey(),
	cursor: varchar('cursor', { length: 500 }).notNull(),
	watermark: timestamp('watermark', { mode: 'string', fsp: 3 }),
	heartbeatAt: timestamp('heartbeatAt', { mode: 'string', fsp: 3 }),
	updatedAt: timestamp('updatedAt', { mode: 'string', fsp: 3 })
		.notNull()
		.defaultNow()
		.onUpdateNow(),
})
