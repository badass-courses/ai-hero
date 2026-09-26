import { contactProfileVersion } from '@/db/contact-sync-schema'
import { isMysqlDuplicateEntryError } from '@/lib/mysql-primary-key-retry'
import { and, eq } from 'drizzle-orm'

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
						updatedAt: contactProfileVersion.updatedAt,
					})
					.from(contactProfileVersion)
					.where(byContact(contactId))
					.limit(1)) as {
					version: number | string
					hash: string | null
					updatedAt: string | Date
				}[]
				const current = rows[0]
				if (current?.hash === contentHash) {
					return {
						profileVersion: Number(current.version),
						since: isoOf(current.updatedAt),
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
						return { profileVersion: 1, since }
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
					return { profileVersion: version + 1, since }
				}
			}
			throw new Error(
				`contact profile version for ${contactId} was contended ${BUMP_ATTEMPTS} times`,
			)
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
