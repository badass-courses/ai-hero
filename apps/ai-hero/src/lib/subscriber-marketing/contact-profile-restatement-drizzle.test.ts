import { createRequire } from 'node:module'
import { drizzle } from 'drizzle-orm/mysql-proxy'
import { describe, expect, it, vi } from 'vitest'

import { createDrizzleContactProfileRestatementStore } from './contact-profile-version-drizzle'
import { valuePathLinkWindowAt } from './value-path-link-anchor'
import { createMemoryContactProfileVersionStore } from './contact-profile-version'
import {
	contactProfileContentHash,
	runContactProfileSync,
	type ContactProfileSnapshot,
} from './drovr-contact-profile-sync'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

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
				'2026-10-10 12:00:00.000',
				90 * 86400,
				90 * 86400,
				86400,
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
			// An acknowledgement at rotation can still represent an old snapshot.
			// The one-day overlap keeps it due until a later read is acknowledged.
			const window = valuePathLinkWindowAt(firstIssue, day(91))
			expect(window.issuedAt).toBe(day(90))
			f.sqlite
				.prepare('UPDATE AI_ContactProfileVersion SET acknowledgedAt = ?')
				.run(sqlTime(window.issuedAt))
			await expect(f.store.listDue(atDay(91))).resolves.toEqual(['quiet'])
			f.sqlite
				.prepare('UPDATE AI_ContactProfileVersion SET acknowledgedAt = ?')
				.run(sqlTime(day(91)))
			await expect(f.store.listDue(atDay(91))).resolves.toEqual([])
		} finally {
			f.sqlite.close()
		}
	})

	it('rediscovers a pre-rotation snapshot acknowledged after rotation, sends rotated links, then clears discovery', async () => {
		const f = fixture()
		const readAt = day(90 - 1 / 86400)
		let clock = day(90 + 1 / 86400)
		const versions = createMemoryContactProfileVersionStore({
			now: () => clock,
		})
		const snapshotAt = (at: string): ContactProfileSnapshot => ({
			occurredAt: at,
			profile: { email: 'race@example.test', firstName: null, holds: [] },
			links: [
				{
					...valuePathLinkWindowAt(firstIssue, at),
					journeyId: 'value-path-skills-course',
					emailKey: 'email-1',
					variables: {},
					sendTimeFields: [],
				},
			],
			offers: [],
		})
		try {
			const oldSnapshot = snapshotAt(readAt)
			expect(oldSnapshot.links[0]!.issuedAt).toBe(firstIssue)
			await versions.versionFor('race', contactProfileContentHash(oldSnapshot))
			await versions.acknowledge('race', 1)
			// Snapshot read one second before rotation; acknowledged one second after.
			f.insert.run('race', 1, 1, sqlTime(clock))
			f.anchor.run('race', sqlTime(firstIssue))
			clock = day(91 + 1 / 86400)
			const nextLap = { startedAt: clock, before: day(31 + 1 / 86400) }
			await expect(f.store.listDue(nextLap)).resolves.toEqual(['race'])
			const deliver = vi.fn(async (_events: DrovrShadowEvent[]) => ({
				accepted: 1,
				rejected: 0,
			}))
			await expect(
				runContactProfileSync({
					event: { data: { contactId: 'race', reason: 'restatement-due' } },
					step: {
						run: async (_id, cb) => cb(),
						sendEvent: async () => undefined,
					},
					env: { AIH_DROVR_PROFILE_SYNC: 'true' },
					readSnapshot: async () => snapshotAt(clock),
					versionFor: versions.versionFor,
					acknowledge: async (id, version) => {
						await versions.acknowledge(id, version)
						f.sqlite
							.prepare(
								'UPDATE AI_ContactProfileVersion SET acknowledgedAt = ?, profileVersion = ?, acknowledgedVersion = ? WHERE contactId = ?',
							)
							.run(sqlTime(clock), version, version, id)
					},
					deliver,
					ownedPath: async () => 'ai-hero-skills-workflow',
					onSendingJourney: async () => true,
					birth: async () => undefined,
					now: () => Date.parse(clock),
				}),
			).resolves.toMatchObject({ status: 'sent', profileVersion: 2, links: 1 })
			const linkEvent = deliver.mock.calls[0]![0].find(
				(event) => event.type === 'contact.links.issued',
			)
			expect(linkEvent?.payload).toMatchObject({
				profileVersion: 2,
				issuedAt: day(90),
				expiresAt: day(210),
			})
			await expect(f.store.listDue(nextLap)).resolves.toEqual([])
			await expect(f.store.listDue(atDay(92))).resolves.toEqual([])
		} finally {
			f.sqlite.close()
		}
	})

	it('does not select a new anchor first issued after acknowledgement before its first rotation', async () => {
		const f = fixture()
		try {
			f.insert.run('quiet', 1, 1, sqlTime(day(60)))
			f.anchor.run('quiet', sqlTime(day(70)))
			await expect(f.store.listDue(atDay(89))).resolves.toEqual([])
			await expect(f.store.listDue(atDay(91))).resolves.toEqual([])
		} finally {
			f.sqlite.close()
		}
	})

	it('acknowledges an inactive anchor rotation with one profile-only re-statement and excludes it on the next lap', async () => {
		const f = fixture()
		let clock = day(60)
		const versions = createMemoryContactProfileVersionStore({
			now: () => clock,
		})
		const snapshot: ContactProfileSnapshot = {
			occurredAt: firstIssue,
			profile: { email: 'inactive@example.test', firstName: null, holds: [] },
			links: [],
			offers: [],
		}
		try {
			f.insert.run('quiet', 1, 1, sqlTime(clock))
			f.anchor.run('quiet', sqlTime(firstIssue))
			await versions.versionFor('quiet', contactProfileContentHash(snapshot))
			await versions.acknowledge('quiet', 1)
			clock = day(91)
			await expect(f.store.listDue(atDay(91))).resolves.toEqual(['quiet'])
			const deliver = vi.fn(async (_events: DrovrShadowEvent[]) => ({
				accepted: 1,
				rejected: 0,
			}))
			await expect(
				runContactProfileSync({
					event: { data: { contactId: 'quiet', reason: 'restatement-due' } },
					step: {
						run: async (_id, cb) => cb(),
						sendEvent: async () => undefined,
					},
					env: { AIH_DROVR_PROFILE_SYNC: 'true' },
					readSnapshot: async () => snapshot,
					versionFor: versions.versionFor,
					acknowledge: async (id, version) => {
						await versions.acknowledge(id, version)
						f.sqlite
							.prepare(
								'UPDATE AI_ContactProfileVersion SET acknowledgedAt = ? WHERE contactId = ?',
							)
							.run(sqlTime(clock), id)
					},
					deliver,
					ownedPath: async () => undefined,
					onSendingJourney: async () => true,
					birth: async () => undefined,
					now: () => Date.parse(clock),
				}),
			).resolves.toMatchObject({
				status: 'sent',
				profileVersion: 1,
				links: 0,
				offers: 0,
			})
			expect(deliver).toHaveBeenCalledOnce()
			expect(deliver.mock.calls[0]![0]).toHaveLength(1)
			expect(deliver.mock.calls[0]![0][0]!.type).toBe('contact.profile.updated')
			await expect(f.store.listDue(atDay(91))).resolves.toEqual([])
			await expect(f.store.listDue(atDay(92))).resolves.toEqual([])
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
