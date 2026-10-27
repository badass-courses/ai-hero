const LOCK_WAIT_TIMEOUT_ERRNO = 1205

export function isLockWaitTimeout(error: unknown): boolean {
	const seen = new Set<unknown>()
	let current: unknown = error
	while (current && typeof current === 'object' && !seen.has(current)) {
		seen.add(current)
		const candidate = current as {
			errno?: unknown
			code?: unknown
			message?: unknown
			cause?: unknown
		}
		if (
			candidate.errno === LOCK_WAIT_TIMEOUT_ERRNO ||
			candidate.code === 'ER_LOCK_WAIT_TIMEOUT'
		) {
			return true
		}
		if (
			typeof candidate.message === 'string' &&
			candidate.message.includes('Lock wait timeout exceeded')
		) {
			return true
		}
		current = candidate.cause
	}
	return false
}

/**
 * Retries the operation once on a lock wait timeout. The capture insert is
 * guarded by a unique semantic idempotency key, so a repeat is safe and a
 * duplicate-key on the retry resolves to a deduped success.
 */
export async function retryOnceOnLockTimeout<T>(
	operation: () => Promise<T>,
): Promise<T> {
	try {
		return await operation()
	} catch (error) {
		if (!isLockWaitTimeout(error)) throw error
		return operation()
	}
}
