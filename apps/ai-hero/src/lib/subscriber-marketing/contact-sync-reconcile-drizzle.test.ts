import type { SQL } from 'drizzle-orm'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { describe, expect, it } from 'vitest'

import {
	CONTACT_SYNC_LATE_CURSOR_NAME,
	createDrizzleContactSyncStore,
	decodeLateCursor,
} from './contact-sync-reconcile-drizzle'

/** Records the scan's WHERE and ORDER BY; answers with no rows. */
function recordingDatabase() {
	const seen: { where?: SQL; orderBy: unknown[] } = { orderBy: [] }
	const database = {
		select: () => ({
			from: () => ({
				where: (clause: SQL) => {
					seen.where = clause
					return {
						orderBy: (...order: unknown[]) => {
							seen.orderBy = order
							return { limit: async () => [] }
						},
					}
				},
			}),
		}),
	}
	return { database, seen }
}

const dialect = new MySqlDialect()
const overlap = {
	scope: 'overlap' as const,
	after: '2026-10-28T07:13:02.343Z',
	through: '2026-10-30T07:13:02.343Z',
	writtenAfter: '2026-10-30T07:13:02.343Z',
	limit: 5000,
}

describe('contact sync store late scan', () => {
	it('bounds the overlap by the late cursor in SQL, in (createdAt, id) order, on the occurredAt range', async () => {
		const { database, seen } = recordingDatabase()
		await createDrizzleContactSyncStore(database).scanChanges({
			...overlap,
			lateCursor: {
				after: { createdAt: '2026-10-30T07:40:12.000Z', id: 'ce_123' },
			},
		})
		const query = dialect.sqlToQuery(seen.where!)
		expect(query.sql).toBe(
			'(`AI_ContactEvent`.`occurredAt` > ? and `AI_ContactEvent`.`occurredAt` <= ? and `AI_ContactEvent`.`createdAt` >= ? and (`AI_ContactEvent`.`createdAt` > ? or (`AI_ContactEvent`.`createdAt` = ? and `AI_ContactEvent`.`id` > ?)))',
		)
		expect(query.params.slice(3)).toEqual([
			expect.anything(),
			expect.anything(),
			'ce_123',
		])
		const [past] = query.params.slice(3) as unknown[]
		expect(String(past)).toMatch(/2026-10-30 07:40:12/)
		expect(
			seen.orderBy.map((order) => dialect.sqlToQuery(order as SQL).sql),
		).toEqual([
			'`AI_ContactEvent`.`createdAt` asc',
			'`AI_ContactEvent`.`id` asc',
		])
	})

	it('orders by write without a bound on the first draining run', async () => {
		const { database, seen } = recordingDatabase()
		await createDrizzleContactSyncStore(database).scanChanges({
			...overlap,
			lateCursor: {},
		})
		expect(dialect.sqlToQuery(seen.where!).sql).not.toContain('`id` >')
		expect(
			seen.orderBy.map((order) => dialect.sqlToQuery(order as SQL).sql),
		).toEqual([
			'`AI_ContactEvent`.`createdAt` asc',
			'`AI_ContactEvent`.`id` asc',
		])
	})

	it('keeps the (occurredAt, id) scan when there is no late cursor', async () => {
		const { database, seen } = recordingDatabase()
		await createDrizzleContactSyncStore(database).scanChanges(overlap)
		expect(dialect.sqlToQuery(seen.where!).sql).not.toContain('`id` >')
		expect(
			seen.orderBy.map((order) => dialect.sqlToQuery(order as SQL).sql),
		).toEqual([
			'`AI_ContactEvent`.`occurredAt` asc',
			'`AI_ContactEvent`.`id` asc',
		])
	})
})

describe('late cursor encoding', () => {
	it('is its own cursor row', () => {
		expect(CONTACT_SYNC_LATE_CURSOR_NAME).toBe('contact-directory:late')
	})

	it('reads back what it wrote, and a blank or unreadable value as none', () => {
		const cursor = {
			after: { createdAt: '2026-10-30T07:40:12.000Z', id: 'ce_123' },
			failing: { contactId: 'contact_1', runs: 2 },
		}
		expect(decodeLateCursor(JSON.stringify(cursor))).toEqual(cursor)
		expect(
			decodeLateCursor(JSON.stringify({ failing: cursor.failing })),
		).toEqual({ failing: cursor.failing })
		for (const value of ['', null, undefined, 'null', '{', '{}'])
			expect(decodeLateCursor(value)).toBeUndefined()
	})
})
