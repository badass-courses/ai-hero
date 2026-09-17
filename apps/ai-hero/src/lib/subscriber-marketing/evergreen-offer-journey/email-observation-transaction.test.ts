import { describe, it, expect, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/mysql2'
import * as schema from '@/db/evergreen-offer-journey-schema'
import type { PoolConnection } from 'mysql2/promise'
import { preserveQueryResultShape } from '@/db/mysql-query-client'

vi.mock('@/db/mysql-query-client', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('@/db/mysql-query-client')>()
	return {
		...actual,
		preserveQueryResultShape: vi.fn(actual.preserveQueryResultShape),
	}
})
import {
	createOwnedEmailObservationTransactions,
	createMySqlEmailObservationLeaseSource,
	type EmailObservationLease,
} from './email-observation-transaction'

function fixture(fault?: 'set' | 'begin' | 'commit' | 'rollback') {
	const calls: string[] = [],
		failure = new Error('original failure')
	const database = drizzle.mock({ schema, mode: 'planetscale' })
	const action = (name: string) => async () => {
		calls.push(name)
		if (name === fault) throw failure
	}
	const lease: EmailObservationLease = {
		database,
		setSerializable: action('set'),
		begin: action('begin'),
		commit: action('commit'),
		rollback: action('rollback'),
		release: () => {
			calls.push('release')
		},
		destroy: () => {
			calls.push('destroy')
		},
	}
	const acquire = vi.fn(async () => lease)
	return {
		calls,
		failure,
		database,
		lease,
		acquire,
		runner: createOwnedEmailObservationTransactions({ acquire }),
	}
}
describe('observation-owned transaction lifecycle', () => {
	it('construction failure after acquisition destroys once without releasing or replacing the error', async () => {
		const failure = new Error('synthetic connection shaping failure')
		const connection = { destroy: vi.fn(), release: vi.fn() }
		// Only disposal is reachable: shaping throws before Drizzle uses the client.
		const getConnection = vi.fn(
			async () => connection as unknown as PoolConnection,
		)
		vi.mocked(preserveQueryResultShape).mockImplementationOnce(() => {
			throw failure
		})
		const source = createMySqlEmailObservationLeaseSource({
			pool: { getConnection },
		})
		await expect(source.acquire()).rejects.toBe(failure)
		expect(getConnection).toHaveBeenCalledOnce()
		expect(preserveQueryResultShape).toHaveBeenCalledWith(connection)
		expect(connection.destroy).toHaveBeenCalledOnce()
		expect(connection.release).not.toHaveBeenCalled()
	})
	it('starting → active → committing → clean: release only after acknowledged COMMIT', async () => {
		const f = fixture(),
			result = { recorded: true }
		expect(
			await f.runner.run(async (db) => {
				expect(db).toBe(f.database)
				f.calls.push('callback')
				return result
			}),
		).toBe(result)
		expect(f.calls).toEqual(['set', 'begin', 'callback', 'commit', 'release'])
	})
	it.each(['set', 'begin', 'commit'] as const)(
		'%s uncertainty destroys once and preserves original error',
		async (fault) => {
			const f = fixture(fault)
			await expect(
				f.runner.run(async () => {
					f.calls.push('callback')
				}),
			).rejects.toBe(f.failure)
			expect(f.calls).toEqual(
				fault === 'set'
					? ['set', 'destroy']
					: fault === 'begin'
						? ['set', 'begin', 'destroy']
						: ['set', 'begin', 'callback', 'commit', 'destroy'],
			)
		},
	)
	it('callback failure rolls back, releases once, and preserves validation error identity', async () => {
		const f = fixture(),
			validation = new Error('validation')
		await expect(
			f.runner.run(async () => {
				throw validation
			}),
		).rejects.toBe(validation)
		expect(f.calls).toEqual(['set', 'begin', 'rollback', 'release'])
	})
	it('failed ROLLBACK destroys once without replacing the original validation error', async () => {
		const f = fixture('rollback'),
			validation = new Error('validation')
		await expect(
			f.runner.run(async () => {
				throw validation
			}),
		).rejects.toBe(validation)
		expect(f.calls).toEqual(['set', 'begin', 'rollback', 'destroy'])
	})
	it('failed acquisition owns no lease to dispose', async () => {
		const failure = new Error('acquire'),
			acquire = vi.fn(async (): Promise<EmailObservationLease> => {
				throw failure
			})
		await expect(
			createOwnedEmailObservationTransactions({ acquire }).run(async () => {}),
		).rejects.toBe(failure)
		expect(acquire).toHaveBeenCalledOnce()
	})
})
