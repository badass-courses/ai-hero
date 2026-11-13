import { createRequire } from 'node:module'
import { drizzle } from 'drizzle-orm/mysql-proxy'
import { describe, expect, it } from 'vitest'

import { createDrizzleContactProfileRestatementStore } from './contact-profile-version-drizzle'

// Load the Node builtin directly; this Vitest version predates node:sqlite.
const { DatabaseSync } = createRequire(import.meta.url)(
	'node:sqlite',
) as typeof import('node:sqlite')

// Execute Drizzle's actual SELECT against an in-memory SQL fixture. This query
// uses only comparisons, ordering and LIMIT, shared by SQLite and MySQL.
function fixture() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		'CREATE TABLE AI_ContactProfileVersion (contactId TEXT PRIMARY KEY, profileVersion INTEGER, acknowledgedVersion INTEGER, acknowledgedAt TEXT)',
	)
	const insert = sqlite.prepare(
		'INSERT INTO AI_ContactProfileVersion VALUES (?, ?, ?, ?)',
	)
	const queries: { sql: string; params: unknown[] }[] = []
	const db = drizzle(async (sql, params) => {
		queries.push({ sql, params })
		return {
			rows: sqlite
				.prepare(sql)
				.all(...params)
				.map(Object.values),
		}
	})
	return {
		sqlite,
		insert,
		queries,
		store: createDrizzleContactProfileRestatementStore(db),
	}
}

const before = '2026-10-03T12:00:00.000Z'

describe('profile re-statement selection', () => {
	it('includes null acknowledgements, excludes recent and unacknowledged versions, and orders oldest first before applying the cap', async () => {
		const f = fixture()
		try {
			f.insert.run('recent', 4, 4, '2026-10-04 00:00:00.000')
			f.insert.run('boundary', 4, 4, '2026-10-03 12:00:00.000')
			f.insert.run('newer-due', 4, 4, '2026-10-02 12:00:00.000')
			f.insert.run('oldest-due', 4, 4, '2026-09-01 00:00:00.000')
			f.insert.run('null-ack', 4, 4, null)
			f.insert.run('unacknowledged', 4, 3, null)
			f.insert.run('never-acknowledged', 4, null, null)
			await expect(f.store.listDue({ before, limit: 2 })).resolves.toEqual([
				'null-ack',
				'oldest-due',
			])
			await expect(f.store.listDue({ before })).resolves.toEqual([
				'null-ack',
				'oldest-due',
				'newer-due',
			])
			expect(f.queries[0]!.params).toEqual(['2026-10-03 12:00:00.000', 2])
			expect(f.queries[0]!.sql).toContain(
				'order by `AI_ContactProfileVersion`.`acknowledgedAt` asc, `AI_ContactProfileVersion`.`contactId` asc limit ?',
			)
		} finally {
			f.sqlite.close()
		}
	})

	it('defaults to a cap of 1500 and breaks null timestamp ties by contact', async () => {
		const f = fixture()
		try {
			for (let i = 1501; i >= 0; i--)
				f.insert.run(`contact-${String(i).padStart(4, '0')}`, 1, 1, null)
			const selected = await f.store.listDue({ before })
			expect(selected).toHaveLength(1500)
			expect(selected[0]).toBe('contact-0000')
			expect(selected.at(-1)).toBe('contact-1499')
		} finally {
			f.sqlite.close()
		}
	})
})
