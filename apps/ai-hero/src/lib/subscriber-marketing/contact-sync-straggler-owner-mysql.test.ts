import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { createStragglerOwnerStore } from './contact-sync-straggler-owner-mysql'
import {
	claimStragglerOwner,
	stragglerOwnerKey,
	STRAGGLER_PARK_AFTER_MS,
} from './contact-sync-straggler-owner'

// Adapter port tests ONLY: these do NOT prove MySQL syntax/isolation/concurrency.
const now = Date.parse('2032-01-01T00:00:00Z'),
	key = stragglerOwnerKey('synthetic')
function port() {
	let cursor = 'null'
	const trace: string[] = []
	const query = vi.fn(async (sql: string, values?: unknown[]) => {
		trace.push(sql.split(' ')[0]!)
		if (sql.startsWith('SELECT')) return [[{ cursor, nowMs: String(now) }], []]
		if (sql.startsWith('UPDATE')) {
			expect(values?.[2]).toBe(cursor)
			cursor = String(values?.[0])
			return [{ affectedRows: 1 }, []]
		}
		return [{ affectedRows: 1 }, []]
	})
	const connection = {
		beginTransaction: vi.fn(async () => {
			trace.push('BEGIN')
		}),
		query,
		commit: vi.fn(async () => {
			trace.push('COMMIT')
		}),
		rollback: vi.fn(async () => {
			trace.push('ROLLBACK')
		}),
		release: vi.fn(() => {
			trace.push('RELEASE')
		}),
		destroy: vi.fn(),
	}
	const store = createStragglerOwnerStore(
		async () => connection as unknown as PoolConnection,
	)
	let sequence = 0
	const claim = (runId = `synthetic-run-${++sequence}`) =>
		store.update(key, (owner, clock) =>
			claimStragglerOwner(
				owner,
				{ protocol: 1, startedAt: now },
				1,
				clock,
				runId,
			),
		)
	return {
		store,
		claim,
		query,
		connection,
		trace,
		setCursor: (value: string) => {
			cursor = value
		},
		cursor: () => cursor,
	}
}
it('owner adapter bootstraps, locks, reads DBUTC, CAS writes and commits before releasing', async () => {
	const h = port(),
		decision = await h.claim()
	expect(decision.status).toBe('claimed')
	expect(decision.owner.deadline).toBe(now + STRAGGLER_PARK_AFTER_MS)
	expect(h.trace).toEqual([
		'BEGIN',
		'INSERT',
		'SELECT',
		'UPDATE',
		'COMMIT',
		'RELEASE',
	])
	expect(h.query.mock.calls[0]![0]).toContain(
		'ON DUPLICATE KEY UPDATE `name` = `name`',
	)
	expect(h.query.mock.calls[0]![0]).not.toContain('IGNORE')
	expect(h.query.mock.calls[1]![0]).toContain('UTC_TIMESTAMP(6)')
	expect(h.query.mock.calls[1]![0]).toContain('FOR UPDATE')
	expect(h.query.mock.calls[2]![0]).toContain('AND `cursor` = ?')
	expect(h.cursor().length).toBeLessThanOrEqual(500)
})
/** Deterministic model of the documented InnoDB duplicate-record locks, NOT
 * observation of the failed fixture's original SQL error. Oracle manual:
 * https://docs.oracle.com/cd/E17952_01/mysql-8.0-en/innodb-locks-set.html */
it('duplicate-X-lock bootstrap avoids the old shared-lock upgrade cycle in the two-transaction model', async () => {
	const h = port()
	await h.claim()
	const bootstrap = h.query.mock.calls[0]![0]
	function model(sql: string) {
		const shared = new Set<string>(),
			waiting = new Map<string, Set<string>>()
		let exclusive: string | undefined
		const requestX = (who: string) => {
			const blockers = new Set([...shared].filter((other) => other !== who))
			if (exclusive && exclusive !== who) blockers.add(exclusive)
			waiting.set(who, blockers)
			if (blockers.size) return false
			exclusive = who
			shared.delete(who)
			return true
		}
		const boot = (who: string) => {
			if (sql.includes('ON DUPLICATE KEY UPDATE')) return requestX(who)
			if (!sql.startsWith('INSERT IGNORE'))
				throw Error('Unsupported model statement')
			shared.add(who)
			return true
		}
		boot('A')
		boot('B')
		requestX('A')
		requestX('B')
		return {
			cycle: !!waiting.get('A')?.has('B') && !!waiting.get('B')?.has('A'),
			waiting,
		}
	}
	expect(model(bootstrap).cycle).toBe(false)
	const oldBootstrap = bootstrap
		.replace('INSERT INTO', 'INSERT IGNORE INTO')
		.split(' ON DUPLICATE KEY UPDATE')[0]!
	expect(model(oldBootstrap).cycle).toBe(true)
	// Old INSERT IGNORE is the negative control: this model must catch it.
})
it('joined starter does not issue a no-op UPDATE or depend on CLIENT_FOUND_ROWS', async () => {
	const h = port()
	await h.claim()
	h.trace.length = 0
	expect((await h.claim()).status).toBe('joined')
	expect(h.trace).toEqual(['BEGIN', 'INSERT', 'SELECT', 'COMMIT', 'RELEASE'])
})
it('adapter rejects unrelated cursor namespaces before acquiring a connection', async () => {
	const acquire = vi.fn(),
		store = createStragglerOwnerStore(acquire)
	await expect(
		store.update('some-other-stream', () => {
			throw Error()
		}),
	).rejects.toThrow('namespace')
	expect(acquire).not.toHaveBeenCalled()
})
it.each([
	'{broken',
	'{}',
	JSON.stringify({
		generation: 'bad',
		state: 'active',
		startedAt: now,
		deadline: now + 1,
		next: 1,
	}),
])(
	'malformed retained cursor refuses without repair or a write: %s',
	async (value) => {
		const h = port()
		h.setCursor(value)
		await expect(h.claim()).rejects.toThrow()
		expect(h.connection.rollback).toHaveBeenCalledOnce()
		expect(h.connection.release).toHaveBeenCalledOnce()
		expect(h.connection.commit).not.toHaveBeenCalled()
		expect(h.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(
			false,
		)
	},
)
it('failed claim CAS rolls back and never reports ownership', async () => {
	const h = port(),
		query = h.query.getMockImplementation()!
	h.query.mockImplementation(async (sql, values) =>
		sql.startsWith('UPDATE') ? [{ affectedRows: 0 }, []] : query(sql, values),
	)
	await expect(h.claim()).rejects.toThrow('CAS')
	expect(h.connection.commit).not.toHaveBeenCalled()
	expect(h.connection.rollback).toHaveBeenCalledOnce()
})
it.each([false, true])(
	'SQL-shaped failure preserves identity and never releases after destroy (destroy throws: %s)',
	async (destroyThrows) => {
		const h = port(),
			original = Object.assign(new Error('synthetic SQL fault'), {
				code: 'ER_LOCK_DEADLOCK',
				errno: 1213,
				sqlState: '40001',
			})
		h.query.mockRejectedValueOnce(original)
		h.connection.rollback.mockRejectedValueOnce(
			new Error('synthetic rollback failure'),
		)
		if (destroyThrows)
			h.connection.destroy.mockImplementationOnce(() => {
				throw new Error('synthetic destroy failure')
			})
		await expect(h.claim()).rejects.toBe(original)
		expect(h.connection.destroy).toHaveBeenCalledOnce()
		expect(h.connection.release).not.toHaveBeenCalled()
	},
)
it('oversized cursor name is rejected before acquiring a connection or issuing SQL', async () => {
	const acquire = vi.fn(),
		store = createStragglerOwnerStore(acquire)
	await expect(
		store.update(`straggler-owner:${'f'.repeat(240)}`, () => {
			throw new Error('must not run')
		}),
	).rejects.toThrow('name exceeds 255')
	expect(acquire).not.toHaveBeenCalled()
})
it('same-run SQL claim replay returns claimed without a second cursor update', async () => {
	const h = port(),
		first = await h.claim('same-run')
	h.query.mockClear()
	const replay = await h.claim('same-run')
	expect(replay.status).toBe('claimed')
	expect(replay.owner).toEqual(first.owner)
	expect(h.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(
		false,
	)
})
it.each([
	{ claimedBy: 'invalid@address' },
	{ claimedBy: 'x'.repeat(65) },
	{ park: null },
	{ park: { at: now, code: 'event-not-live', types: 'not-an-array' } },
	{ park: { at: now, code: 'event-not-live', types: [42] } },
	{ park: { at: now, code: 'invalid@address', types: [] } },
	{ park: { at: now, code: 'event-not-live', types: [], alerted: false } },
])('rejects malformed retained claimant/park metadata: %j', async (patch) => {
	const h = port()
	await h.claim()
	h.setCursor(JSON.stringify({ ...JSON.parse(h.cursor()), ...patch }))
	h.query.mockClear()
	await expect(h.claim()).rejects.toThrow('malformed retained')
	expect(h.connection.rollback).toHaveBeenCalledOnce()
	expect(h.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(
		false,
	)
})
it('oversized cursor is refused, not trimmed or committed', async () => {
	const h = port()
	await expect(
		h.store.update(key, (_owner, clock) => ({
			owner: {
				generation: 'x'.repeat(600),
				state: 'active',
				startedAt: clock,
				deadline: clock + STRAGGLER_PARK_AFTER_MS,
				next: 1,
			},
			value: true,
		})),
	).rejects.toThrow('exceeds')
	expect(h.connection.commit).not.toHaveBeenCalled()
})
