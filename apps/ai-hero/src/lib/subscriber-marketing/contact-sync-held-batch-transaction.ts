import { HeldBatchContinuationError } from './contact-sync-held-batch'

function isDeadlock(error: unknown): boolean {
	let current: unknown = error
	for (
		let depth = 0;
		depth < 6 && typeof current === 'object' && current !== null;
		depth++
	) {
		if (
			('errno' in current && current.errno === 1213) ||
			('code' in current && current.code === 'ER_LOCK_DEADLOCK')
		)
			return true
		current = 'cause' in current ? current.cause : undefined
	}
	return false
}

/** Retry only a database-rolled-back deadlock, never a broker/HTTP operation.
 * No polling, session SET, clock rebase or partial transaction is retained. */
export async function retryHeldBatchTransaction<A>(
	run: () => Promise<A>,
): Promise<A> {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await run()
		} catch (error) {
			if (!isDeadlock(error)) throw error
			if (attempt === 2)
				throw new HeldBatchContinuationError({
					reason:
						'bounded transaction contention did not clear; no incomplete pin registration or evidence purge was committed',
				})
		}
	}
	throw new HeldBatchContinuationError({
		reason: 'the bounded transaction did not produce a committed result',
	})
}
