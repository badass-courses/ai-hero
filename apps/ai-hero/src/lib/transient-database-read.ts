type RetryOptions = {
	attempts?: number
	baseDelayMs?: number
	sleep?: (milliseconds: number) => Promise<void>
}

export function isTransientDatabaseReadError(error: unknown) {
	const candidate = error as {
		status?: number
		message?: string
		body?: { message?: string }
	}
	if (candidate.status && candidate.status >= 500 && candidate.status <= 599) {
		return true
	}

	const message = `${candidate.message ?? ''} ${candidate.body?.message ?? ''}`
	return /service unavailable|internal server error/i.test(message)
}

/** Retry only transient 5xx database reads used to fill public caches. */
export async function retryTransientDatabaseRead<T>(
	operation: () => Promise<T>,
	{
		attempts = 4,
		baseDelayMs = 250,
		sleep = (milliseconds) =>
			new Promise((resolve) => setTimeout(resolve, milliseconds)),
	}: RetryOptions = {},
) {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await operation()
		} catch (error) {
			if (attempt >= attempts || !isTransientDatabaseReadError(error)) {
				throw error
			}
			await sleep(baseDelayMs * 2 ** (attempt - 1))
		}
	}
}
