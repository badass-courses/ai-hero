import { valuePathLinkAnchor } from '@/db/contact-sync-schema'
import { eq } from 'drizzle-orm'

import {
	valuePathLinkAnchorRowKey,
	type ValuePathLinkAnchor,
	type ValuePathLinkAnchorKey,
	type ValuePathLinkAnchorStore,
} from './value-path-link-anchor'

/**
 * The AI_ValuePathLinkAnchor-backed store. Insert-or-read: a duplicate key
 * from a concurrent first issue answers 'exists', and the caller re-reads
 * the row that won. The row is the first issue and is never updated. A missing table (1146) throws, and
 * resolveValuePathLinkAnchor turns that into the previous behaviour.
 */
export function createDrizzleValuePathLinkAnchorStore(
	// The same shape the capture repository takes; drizzle's MySqlDatabase
	// generics are unwieldy here and this module only uses select/insert.
	database: unknown,
): ValuePathLinkAnchorStore {
	const db = database as {
		select: (fields: unknown) => {
			from: (table: unknown) => {
				where: (clause: unknown) => { limit: (n: number) => Promise<unknown[]> }
			}
		}
		insert: (table: unknown) => {
			values: (values: unknown) => Promise<unknown>
		}
	}
	const keyClause = (key: ValuePathLinkAnchorKey) =>
		eq(valuePathLinkAnchor.anchorKey, valuePathLinkAnchorRowKey(key))
	return {
		async find(key) {
			const rows = (await db
				.select({
					issuedAt: valuePathLinkAnchor.issuedAt,
					expiresAt: valuePathLinkAnchor.expiresAt,
				})
				.from(valuePathLinkAnchor)
				.where(keyClause(key))
				.limit(1)) as { issuedAt: string; expiresAt: string }[]
			const row = rows[0]
			if (!row) return undefined
			return {
				issuedAt: isoOf(row.issuedAt),
				expiresAt: isoOf(row.expiresAt),
			} satisfies ValuePathLinkAnchor
		},
		async insert(key, anchor) {
			try {
				await db.insert(valuePathLinkAnchor).values({
					anchorKey: valuePathLinkAnchorRowKey(key),
					...key,
					...sqlTimestamps(anchor),
				})
				return 'inserted'
			} catch (error) {
				if (isDuplicateKey(error)) return 'exists'
				throw error
			}
		},
	}
}

/** MySQL timestamp(3) columns take 'YYYY-MM-DD HH:MM:SS.mmm' in UTC. */
function sqlTimestamps(anchor: ValuePathLinkAnchor) {
	return {
		issuedAt: toSqlTimestamp(anchor.issuedAt),
		expiresAt: toSqlTimestamp(anchor.expiresAt),
	}
}

function toSqlTimestamp(iso: string): string {
	return new Date(iso).toISOString().slice(0, 23).replace('T', ' ')
}

function isoOf(value: string | Date): string {
	if (value instanceof Date) return value.toISOString()
	// The driver hands back 'YYYY-MM-DD HH:MM:SS.mmm' in UTC.
	return /(Z|[+-]\d{2}:?\d{2})$/.test(value)
		? new Date(value).toISOString()
		: new Date(`${value.replace(' ', 'T')}Z`).toISOString()
}

function isDuplicateKey(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false
	const record = error as { errno?: unknown; code?: unknown; message?: unknown }
	return (
		record.errno === 1062 ||
		record.code === 'ER_DUP_ENTRY' ||
		(typeof record.message === 'string' &&
			record.message.includes('Duplicate entry'))
	)
}
