import { ConvertKitApiError } from '@coursebuilder/core/providers/convertkit'

export const KIT_WRITE_MAX_ATTEMPTS = 3
export const KIT_WRITE_BASE_DELAY_MS = 250
const KIT_WRITE_MAX_DELAY_MS = 2_000

export function isRetryableKitWriteError(
	error: unknown,
): error is ConvertKitApiError {
	return (
		error instanceof ConvertKitApiError &&
		(error.status === 429 || (error.status >= 500 && error.status <= 599))
	)
}

export async function retryKitWrite<T>({
	write,
	sleep = (milliseconds) =>
		new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
	onRetry,
}: {
	write: () => Promise<T>
	sleep?: (milliseconds: number) => Promise<void>
	onRetry?: (receipt: {
		attempt: number
		status: number
		delayMs: number
	}) => void | Promise<void>
}): Promise<T> {
	for (let attempt = 1; attempt <= KIT_WRITE_MAX_ATTEMPTS; attempt++) {
		try {
			return await write()
		} catch (error) {
			if (
				!isRetryableKitWriteError(error) ||
				attempt === KIT_WRITE_MAX_ATTEMPTS
			) {
				throw error
			}

			const delayMs = kitWriteRetryDelayMs(error, attempt)
			await onRetry?.({ attempt, status: error.status, delayMs })
			await sleep(delayMs)
		}
	}

	throw new Error('Kit write retry exhausted without a result')
}

function kitWriteRetryDelayMs(error: ConvertKitApiError, attempt: number) {
	const retryAfter = error.responseHeaders['retry-after']
	const retryAfterSeconds = retryAfter ? Number(retryAfter) : Number.NaN
	if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
		return Math.min(retryAfterSeconds * 1_000, KIT_WRITE_MAX_DELAY_MS)
	}

	return Math.min(
		KIT_WRITE_BASE_DELAY_MS * 2 ** (attempt - 1),
		KIT_WRITE_MAX_DELAY_MS,
	)
}
