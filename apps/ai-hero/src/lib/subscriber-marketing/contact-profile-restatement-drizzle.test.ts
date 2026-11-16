import { createRequire } from 'node:module'
import { drizzle } from 'drizzle-orm/mysql-proxy'
import { describe, expect, it } from 'vitest'

import { createDrizzleContactProfileRestatementStore } from './contact-profile-version-drizzle'
import { valuePathLinkWindowAt } from './value-path-link-anchor'

// Load the Node builtin directly; this Vitest version predates node:sqlite.
const { DatabaseSync } = createRequire(import.meta.url)(
	'node:sqlite',
) as typeof import('node:sqlite')

// Execute Drizzle's actual SELECT, including the correlated EXISTS. These
// scalar shims implement MySQL's UTC epoch arithmetic on the SQL fixture.
function fixture() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.function('unix_timestamp', (value) =>
		value === null
			? null
			: Date.parse(`${String(value).replace(' ', 'T')}Z`) / 1000,
	)
	sqlite.function('greatest', (a, b) => Math.max(Number(a), Number(b)))
	sqlite.function('floor', (value) => Math.floor(Number(value)))
	sqlite.exec(
		'CREATE TABLE AI_ContactProfileVersion (contactId TEXT PRIMARY KEY, profileVersion INTEGER, acknowledgedVersion INTEGER, acknowledgedAt TEXT); CREATE TABLE AI_ValuePathLinkAnchor (contactId TEXT, issuedAt TEXT)',
	)
	const insert = sqlite.prepare(
		'INSERT INTO AI_ContactProfileVersion VALUES (?, ?, ?, ?)',
	)
	const anchor = sqlite.prepare(
		'INSERT INTO AI_ValuePathLinkAnchor VALUES (?, ?)',
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
		anchor,
		queries,
		store: createDrizzleContactProfileRestatementStore(db),
	}
}

const before = '2026-10-03T12:00:00.000Z'
const startedAt = '2026-10-10T12:00:00.000Z'
const firstIssue = '2026-01-01T00:00:00.000Z'
const day = (n: number) =>
	new Date(Date.parse(firstIssue) + n * 86400000).toISOString()
const sqlTime = (iso: string) => iso.slice(0, 23).replace('T', ' ')

function atDay(n: number) {
	return { startedAt: day(n), before: day(n - 60) }
}

describe('profile re-statement selection', () => {
	it('includes null acknowledgements, excludes recent and unacknowledged versions, and walks contactId order before applying the cap', async () => {
		const f = fixture()
		try {
			f.insert.run('recent', 4, 4, '2026-10-04 00:00:00.000')
			f.insert.run('boundary', 4, 4, '2026-10-03 12:00:00.000')
			f.insert.run('newer-due', 4, 4, '2026-10-02 12:00:00.000')
			f.insert.run('oldest-due', 4, 4, '2026-09-01 00:00:00.000')
			f.insert.run('null-ack', 4, 4, null)
			f.insert.run('unacknowledged', 4, 3, null)
			f.insert.run('never-acknowledged', 4, null, null)
			await expect(
				f.store.listDue({ before, startedAt, limit: 2 }),
			).resolves.toEqual(['newer-due', 'null-ack'])
			await expect(f.store.listDue({ before, startedAt })).resolves.toEqual([
				'newer-due',
				'null-ack',
				'oldest-due',
			])
			await expect(
				f.store.listDue({ before, startedAt, after: 'null-ack' }),
			).resolves.toEqual(['oldest-due'])
			expect(f.queries[0]!.params).toEqual([
				'2026-10-03 12:00:00.000',
				'2026-10-10 12:00:00.000',
				90 * 86400,
				90 * 86400,
				2,
			])
			expect(f.queries[0]!.sql).toContain(
				'order by `AI_ContactProfileVersion`.`contactId` asc limit ?',
			)
		} finally {
			f.sqlite.close()
		}
	})

	it('defaults to a cap of 1500 in contactId order', async () => {
		const f = fixture()
		try {
			for (let i = 1501; i >= 0; i--)
				f.insert.run(`contact-${String(i).padStart(4, '0')}`, 1, 1, null)
			const selected = await f.store.listDue({ before, startedAt })
			expect(selected).toHaveLength(1500)
			expect(selected[0]).toBe('contact-0000')
			expect(selected.at(-1)).toBe('contact-1499')
		} finally {
			f.sqlite.close()
		}
	})

	it('finds a quiet contact by age at day 60 plus the strict cutoff, not by rotation', async () => {
		const f = fixture()
		try {
			f.insert.run('quiet', 1, 1, sqlTime(firstIssue))
			f.anchor.run('quiet', sqlTime(firstIssue))
			await expect(f.store.listDue(atDay(60))).resolves.toEqual([])
			await expect(f.store.listDue(atDay(60.00001))).resolves.toEqual(['quiet'])
		} finally {
			f.sqlite.close()
		}
	})

	it('discovers rotation at day 90 and day 91 despite a day-60 acknowledgement, but not at day 89', async () => {
		const f = fixture()
		try {
			f.insert.run('quiet', 1, 1, sqlTime(day(60)))
			f.anchor.run('quiet', sqlTime(firstIssue))
			await expect(f.store.listDue(atDay(89))).resolves.toEqual([])
			await expect(f.store.listDue(atDay(90))).resolves.toEqual(['quiet'])
			await expect(f.store.listDue(atDay(91))).resolves.toEqual(['quiet'])
			// The resolver and SQL agree: acknowledging this window stops discovery.
			const window = valuePathLinkWindowAt(firstIssue, day(91))
			expect(window.issuedAt).toBe(day(90))
			f.sqlite
				.prepare('UPDATE AI_ContactProfileVersion SET acknowledgedAt = ?')
				.run(sqlTime(window.issuedAt))
			await expect(f.store.listDue(atDay(91))).resolves.toEqual([])
		} finally {
			f.sqlite.close()
		}
	})

	it('correlates anchors by contact, deduplicates multiple anchors, excludes unacknowledged versions, and preserves cursor walks', async () => {
		const f = fixture()
		try {
			for (const id of ['a', 'b', 'c', 'no-anchor', 'unacked'])
				f.insert.run(id, 2, id === 'unacked' ? 1 : 2, sqlTime(day(60)))
			for (const id of ['a', 'b', 'c', 'unacked']) {
				f.anchor.run(id, sqlTime(firstIssue))
				f.anchor.run(id, sqlTime(firstIssue))
			}
			await expect(
				f.store.listDue({ ...atDay(91), limit: 2 }),
			).resolves.toEqual(['a', 'b'])
			await expect(
				f.store.listDue({ ...atDay(91), after: 'b', limit: 2 }),
			).resolves.toEqual(['c'])
			await expect(
				f.store.listDue({ ...atDay(91), after: 'c', limit: 2 }),
			).resolves.toEqual([])
			// A wrapped lap starts at the same first page.
			await expect(
				f.store.listDue({ ...atDay(91), limit: 2 }),
			).resolves.toEqual(['a', 'b'])
		} finally {
			f.sqlite.close()
		}
	})
})
