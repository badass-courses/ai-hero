export const MAX_STEP_ATTEMPTS = 3

export function isDeadlock(error: unknown): boolean {
	// Walk the cause chain: drivers/ORMs wrap the mysql error.
	for (let e: any = error, i = 0; e && i < 5; e = e.cause, i++) {
		if (e.errno === 1213 || e.code === 'ER_LOCK_DEADLOCK') return true
	}
	return false
}

/** Mirrors Inngest step retries, limited to InnoDB deadlock victims. */
export async function runWithDeadlockRetry<T>(fn: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn()
		} catch (error) {
			if (attempt >= MAX_STEP_ATTEMPTS || !isDeadlock(error)) throw error
		}
	}
}
