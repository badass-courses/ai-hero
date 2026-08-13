export interface CloseableDatabasePool {
	end(): Promise<void>
}

/**
 * Makes pool cleanup awaitable and idempotent for finite CLI processes.
 * Server runtimes keep the pool open and never call the returned closer.
 */
export function createDatabasePoolCloser(pool: CloseableDatabasePool) {
	let closing: Promise<void> | undefined
	return () => {
		closing ??= pool.end()
		return closing
	}
}
