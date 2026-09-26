import { contactProfileVersion } from '@/db/contact-sync-schema'
import { isMysqlDuplicateEntryError } from '@/lib/mysql-primary-key-retry'
import { and, eq } from 'drizzle-orm'

import type { ContactProfileVersionStore } from './contact-profile-version'

/** Enough for the per-contact concurrency of one the sync function runs at. */
const BUMP_ATTEMPTS = 8

/**
 * The AI_ContactProfileVersion-backed counter. A bump is a compare-and-swap
 * on the version it read (or an insert of 1 that a concurrent first bump may
 * win), so two bumps never return the same version on any MySQL, Vitess
 * included.
 */
export function createDrizzleContactProfileVersionStore(
	// The same shape the capture repository takes; drizzle's MySqlDatabase
	// generics are unwieldy here and this module only uses select/insert/update.
	database: unknown,
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
		async bump(contactId) {
			for (let attempt = 0; attempt < BUMP_ATTEMPTS; attempt += 1) {
				const rows = (await db
					.select({ version: contactProfileVersion.profileVersion })
					.from(contactProfileVersion)
					.where(byContact(contactId))
					.limit(1)) as { version: number | string }[]
				const current = rows[0]
				if (!current) {
					try {
						await db.insert(contactProfileVersion).values({
							contactId,
							profileVersion: 1,
						})
						return 1
					} catch (error) {
						if (isMysqlDuplicateEntryError(error)) continue
						throw error
					}
				}
				const version = Number(current.version)
				const result = await db
					.update(contactProfileVersion)
					.set({ profileVersion: version + 1 })
					.where(
						and(
							byContact(contactId),
							eq(contactProfileVersion.profileVersion, version),
						),
					)
				if (affectedRows(result) === 1) return version + 1
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
