import { ConvertKitApiError } from '@coursebuilder/core/providers/convertkit'

export const KIT_RATE_LIMIT_DELAY_MS = 60_000
export const KIT_RATE_LIMIT_JITTER_MS = 5_000
export const KIT_SERVER_ERROR_BASE_DELAY_MS = 1_000

export type KitWriteRetrySchedule = {
	status: number
	delayMs: number
	delaySource: 'retry-after' | 'rate-limit-window' | 'server-error'
}

export function isRetryableKitWriteError(
	error: unknown,
): error is ConvertKitApiError {
	return (
		error instanceof ConvertKitApiError &&
		(error.status === 429 || (error.status >= 500 && error.status <= 599))
	)
}

/**
 * Calculate an outer durable retry schedule. This function never sleeps and
 * never repeats a provider call. Inngest owns the later attempt.
 */
export function kitWriteRetrySchedule(
	error: unknown,
	{
		attempt = 1,
		random = Math.random,
		now = Date.now,
	}: {
		attempt?: number
		random?: () => number
		now?: () => number
	} = {},
): KitWriteRetrySchedule | undefined {
	if (!isRetryableKitWriteError(error)) return undefined

	const retryAfterMs = parseRetryAfterMs(
		error.responseHeaders['retry-after'],
		now(),
	)
	if (retryAfterMs !== undefined) {
		return {
			status: error.status,
			delayMs: retryAfterMs,
			delaySource: 'retry-after',
		}
	}

	if (error.status === 429) {
		return {
			status: error.status,
			delayMs:
				KIT_RATE_LIMIT_DELAY_MS +
				Math.round(clampRandom(random()) * KIT_RATE_LIMIT_JITTER_MS),
			delaySource: 'rate-limit-window',
		}
	}

	return {
		status: error.status,
		delayMs:
			KIT_SERVER_ERROR_BASE_DELAY_MS * attempt +
			Math.round(clampRandom(random()) * KIT_SERVER_ERROR_BASE_DELAY_MS),
		delaySource: 'server-error',
	}
}

function parseRetryAfterMs(value: string | undefined, nowMs: number) {
	if (!value) return undefined

	const seconds = Number(value)
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.ceil(seconds * 1_000)
	}

	const retryAtMs = Date.parse(value)
	if (!Number.isNaN(retryAtMs)) {
		return Math.max(0, retryAtMs - nowMs)
	}

	return undefined
}

function clampRandom(value: number) {
	return Math.min(1, Math.max(0, value))
}
