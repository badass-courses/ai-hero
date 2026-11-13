import {
	contactProfileVersion,
	contactSyncCursor,
} from '@/db/contact-sync-schema'
import { isMysqlDuplicateEntryError } from '@/lib/mysql-primary-key-retry'
import { and, asc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'

import type { ContactProfileVersionStore } from './contact-profile-version'

/** Enough for the per-contact concurrency of one the sync function runs at. */
const BUMP_ATTEMPTS = 8

/**
 * The AI_ContactProfileVersion-backed version, addressed by content. The
 * same hash answers the stored version and when it was set; a new hash is a
 * compare-and-swap on the version it read (or an insert of 1 that a
 * concurrent first sync may win), so two contents never share a version on
 * any MySQL, Vitess included.
 */
export function createDrizzleContactProfileVersionStore(
	// The same shape the capture repository takes; drizzle's MySqlDatabase
	// generics are unwieldy here and this module only uses select/insert/update.
	database: unknown,
	options: { now?: () => string } = {},
): ContactProfileVersionStore {
	const db = database as {
		select: (fields: unknown) => {
			from: (table: unknown) => {
				where: (clause: unknown) => { limit: (n: number) => Promise<unknown[]> }
			}
		}
		insert: (table: unknown) => {
			values: (values: unknown) => Promise<unknown>
		}
		update: (table: unknown) => {
			set: (values: unknown) => { where: (clause: unknown) => Promise<unknown> }
		}
	}
	const byContact = (contactId: string) =>
		eq(contactProfileVersion.contactId, contactId)
	return {
		async versionFor(contactId, contentHash) {
			for (let attempt = 0; attempt < BUMP_ATTEMPTS; attempt += 1) {
				const rows = (await db
					.select({
						version: contactProfileVersion.profileVersion,
						hash: contactProfileVersion.profileHash,
						acknowledgedVersion: contactProfileVersion.acknowledgedVersion,
						acknowledgedAt: contactProfileVersion.acknowledgedAt,
						updatedAt: contactProfileVersion.updatedAt,
					})
					.from(contactProfileVersion)
					.where(byContact(contactId))
					.limit(1)) as {
					version: number | string
					hash: string | null
					acknowledgedVersion: number | string | null
					acknowledgedAt: string | Date | null
					updatedAt: string | Date
				}[]
				const current = rows[0]
				if (current?.hash === contentHash) {
					return {
						profileVersion: Number(current.version),
						since: isoOf(current.updatedAt),
						acknowledgedAt: current.acknowledgedAt
							? isoOf(current.acknowledgedAt)
							: null,
						acknowledged:
							current.acknowledgedVersion !== null &&
							Number(current.acknowledgedVersion) === Number(current.version),
					}
				}
				const since = (options.now ?? (() => new Date().toISOString()))()
				if (!current) {
					try {
						await db.insert(contactProfileVersion).values({
							contactId,
							profileVersion: 1,
							profileHash: contentHash,
							updatedAt: sqlTimestamp(since),
						})
						return {
							profileVersion: 1,
							since,
							acknowledged: false,
							acknowledgedAt: null,
						}
					} catch (error) {
						if (isMysqlDuplicateEntryError(error)) continue
						throw error
					}
				}
				const version = Number(current.version)
				const result = await db
					.update(contactProfileVersion)
					.set({
						profileVersion: version + 1,
						profileHash: contentHash,
						updatedAt: sqlTimestamp(since),
					})
					.where(
						and(
							byContact(contactId),
							eq(contactProfileVersion.profileVersion, version),
						),
					)
				if (affectedRows(result) === 1) {
					return {
						profileVersion: version + 1,
						since,
						acknowledged: false,
						acknowledgedAt: null,
					}
				}
			}
			throw new Error(
				`contact profile version for ${contactId} was contended ${BUMP_ATTEMPTS} times`,
			)
		},
		async acknowledge(contactId, profileVersion) {
			const at = (options.now ?? (() => new Date().toISOString()))()
			// Only the version drovr took, and never a newer one. updatedAt
			// is the version's since (and has ON UPDATE CURRENT_TIMESTAMP):
			// assigning it to itself preserves the version's original timestamp.
			await db
				.update(contactProfileVersion)
				.set({
					acknowledgedVersion: profileVersion,
					acknowledgedAt: sqlTimestamp(at),
					updatedAt: sql`${contactProfileVersion.updatedAt}`,
				})
				.where(
					and(
						byContact(contactId),
						eq(contactProfileVersion.profileVersion, profileVersion),
					),
				)
		},
	}
}

export const PROFILE_RESTATEMENT_CURSOR_NAME = 'drovr-profile-restatement-sweep'

/**
 * Acknowledged profiles due for re-statement, walked in contactId order from
 * a cursor, including contacts without link anchors. Not oldest-first: a
 * contact the sync skips before versioning (unsubscribed, out of scope) is
 * never re-acknowledged, so an oldest-first cap would return the same rows
 * forever. The cursor moves past every row once per lap instead.
 */
export function createDrizzleContactProfileRestatementStore(database: unknown) {
	const db = database as {
		select: (fields: unknown) => {
			from: (table: unknown) => {
				where: (clause: unknown) => {
					orderBy: (...columns: unknown[]) => {
						limit: (n: number) => Promise<{ contactId: string }[]>
					}
					limit: (n: number) => Promise<{ cursor: string }[]>
				}
			}
		}
		insert: (table: unknown) => { values: (values: unknown) => Promise<unknown> }
		update: (table: unknown) => {
			set: (values: unknown) => { where: (clause: unknown) => Promise<unknown> }
		}
	}
	const byName = eq(contactSyncCursor.name, PROFILE_RESTATEMENT_CURSOR_NAME)
	return {
		async readCursor(): Promise<string | undefined> {
			const rows = await db
				.select({ cursor: contactSyncCursor.cursor })
				.from(contactSyncCursor)
				.where(byName)
				.limit(1)
			return rows[0]?.cursor || undefined
		},
		async writeCursor(after: string | undefined): Promise<void> {
			const value = after ?? ''
			try {
				await db
					.insert(contactSyncCursor)
					.values({ name: PROFILE_RESTATEMENT_CURSOR_NAME, cursor: value })
				return
			} catch (error) {
				if (!isMysqlDuplicateEntryError(error)) throw error
			}
			await db.update(contactSyncCursor).set({ cursor: value }).where(byName)
		},
		async listDue(args: {
			before: string
			after?: string
			limit?: number
		}): Promise<string[]> {
			const limit = args.limit ?? 1500
			if (!Number.isSafeInteger(limit) || limit < 1)
				throw new Error('profile restatement limit must be a positive integer')
			const rows = await db
				.select({ contactId: contactProfileVersion.contactId })
				.from(contactProfileVersion)
				.where(
					and(
						eq(
							contactProfileVersion.acknowledgedVersion,
							contactProfileVersion.profileVersion,
						),
						or(
							isNull(contactProfileVersion.acknowledgedAt),
							lt(
								contactProfileVersion.acknowledgedAt,
								sqlTimestamp(args.before),
							),
						),
						args.after
							? gt(contactProfileVersion.contactId, args.after)
							: undefined,
					),
				)
				// The primary key: a range read, deterministic on replay.
				.orderBy(asc(contactProfileVersion.contactId))
				.limit(limit)
			return rows.map(({ contactId }) => contactId)
		},
	}
}

function affectedRows(result: unknown): number {
	const header = Array.isArray(result) ? result[0] : result
	if (!header || typeof header !== 'object') return 0
	const record = header as Record<string, unknown>
	if (typeof record.rowsAffected === 'number') return record.rowsAffected
	if (typeof record.affectedRows === 'number') return record.affectedRows
	return 0
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
