import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { describe, expect, it, vi } from 'vitest'
import type { SQL } from 'drizzle-orm'
import { createDrizzleDrovrOutboxStore } from './drovr-outbox-drizzle'

// Actual DAO query construction, not SQL execution or concurrency proof.
function harness() {
	const writes: { columns: Record<string, unknown>; predicate: SQL }[] = []
	const update = vi.fn(() => ({
		set: (columns: Record<string, unknown>) => ({
			where: async (predicate: SQL) => {
				writes.push({ columns, predicate })
				return [{ affectedRows: 1 }]
			},
		}),
	}))
	return {
		update,
		writes,
		store: createDrizzleDrovrOutboxStore({ update } as never),
	}
}

describe('typed stop-wait pull-forward DAO boundary', () => {
	it('selects only the typed v1 JSON Boolean, never diagnostic prose', async () => {
		const h = harness()
		expect(
			await h.store.pullForward!({
				target: 'synthetic-target',
				contactIds: ['synthetic-contact'],
				now: '2026-10-16T00:00:00.000Z',
			}),
		).toBe(1)
		expect(h.writes).toHaveLength(1)
		const query = new MySqlDialect().sqlToQuery(h.writes[0]!.predicate)
		expect(query.sql).toContain("'$.v'")
		expect(query.sql).toContain("'$.replayProof.v'")
		expect(query.sql).toContain(
			"JSON_TYPE(JSON_EXTRACT(`AI_DrovrOutbox`.`heldContinuation`, '$.replayProof.waitingForStop')) = 'BOOLEAN'",
		)
		expect(query.sql).toContain(
			"JSON_EXTRACT(`AI_DrovrOutbox`.`heldContinuation`, '$.replayProof.waitingForStop') = JSON_EXTRACT('true', '$')",
		)
		expect(query.sql).not.toMatch(/lastError|last_error|LIKE|REGEXP/i)
		expect(query.params).toContain('synthetic-target')
		expect(query.params).toContain('synthetic-contact')
		expect(query.params).toContain('pending')
		expect(query.params).toContain('deferred')
		// Pulling a fact forward consumes only its typed wait marker, not its
		// operator prose, HTTP history, immutable body or first-send clock.
		expect(Object.keys(h.writes[0]!.columns).sort()).toEqual([
			'heldContinuation',
			'nextAttemptAt',
		])
		const control = new MySqlDialect().sqlToQuery(
			h.writes[0]!.columns.heldContinuation as SQL,
		)
		expect(control.sql).toContain(
			"JSON_REMOVE(`AI_DrovrOutbox`.`heldContinuation`, '$.replayProof.waitingForStop')",
		)
	})
	it('does not issue an unscoped update for an empty contact set', async () => {
		const h = harness()
		expect(
			await h.store.pullForward!({
				target: 'synthetic-target',
				contactIds: [],
				now: '2026-10-16T00:00:00.000Z',
			}),
		).toBe(0)
		expect(h.update).not.toHaveBeenCalled()
	})
})
