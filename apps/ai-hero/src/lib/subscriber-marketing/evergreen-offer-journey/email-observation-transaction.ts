import type { Logger } from 'drizzle-orm/logger'
import { drizzle } from 'drizzle-orm/mysql2'
import type { Pool } from 'mysql2/promise'
import * as schema from '@/db/evergreen-offer-journey-schema'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import type { EvergreenOfferJourneyDatabase } from './drizzle-ledger'

type WriteDatabase = Pick<EvergreenOfferJourneyDatabase, 'select' | 'insert'>
/** One exclusive connection. Disposal methods use mysql2's synchronous public
 * release/destroy contract; no pooled transaction or private Drizzle fields. */
export type EmailObservationLease = {
	readonly database: WriteDatabase
	setSerializable(): Promise<void>
	begin(): Promise<void>
	commit(): Promise<void>
	rollback(): Promise<void>
	release(): void
	destroy(): void
}
export type EmailObservationLeaseSource = {
	acquire(): Promise<EmailObservationLease>
}
export type EmailObservationTransactions = {
	run<A>(operation: (database: WriteDatabase) => Promise<A>): Promise<A>
}

/** starting → active → committing → clean. Only acknowledged COMMIT or
 * ROLLBACK reaches clean. Every other exit destroys the exclusive connection.
 * Cleanup covers SET and BEGIN too, unlike the pinned pooled ORM transaction. */
export function createOwnedEmailObservationTransactions(
	source: EmailObservationLeaseSource,
): EmailObservationTransactions {
	return {
		async run(operation) {
			const lease = await source.acquire()
			let phase: 'starting' | 'active' | 'committing' | 'clean' = 'starting'
			try {
				await lease.setSerializable()
				await lease.begin()
				phase = 'active'
				const result = await operation(lease.database)
				phase = 'committing'
				await lease.commit()
				phase = 'clean'
				return result
			} catch (original) {
				if (phase === 'active') {
					try {
						await lease.rollback()
						phase = 'clean'
					} catch {
						/* Still uncertain: destroy. */
					}
				}
				// A rollback failure must not replace an existing validation failure.
				throw original
			} finally {
				if (phase === 'clean') lease.release()
				else lease.destroy()
			}
		},
	}
}

export function createMySqlEmailObservationLeaseSource(options: {
	pool: Pick<Pool, 'getConnection'>
	logger?: Logger
}): EmailObservationLeaseSource {
	return {
		async acquire() {
			const connection = await options.pool.getConnection()
			try {
				const database = drizzle(preserveQueryResultShape(connection), {
					schema,
					mode: 'planetscale',
					logger: options.logger,
				})
				const log = (query: string) => options.logger?.logQuery(query, [])
				return {
					database,
					async setSerializable() {
						log('set transaction isolation level serializable')
						await connection.query(
							'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
						)
					},
					async begin() {
						log('begin')
						await connection.beginTransaction()
					},
					async commit() {
						log('commit')
						await connection.commit()
					},
					async rollback() {
						log('rollback')
						await connection.rollback()
					},
					release: () => connection.release(),
					destroy: () => connection.destroy(),
				}
			} catch (error) {
				connection.destroy()
				throw error
			}
		},
	}
}
