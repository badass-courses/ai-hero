export const DEFAULT_VALUE_PATH_PROVIDER_PACING_MS = 10_000

export function parseValuePathProviderPacingMs(value: string | undefined) {
	if (value === undefined) return DEFAULT_VALUE_PATH_PROVIDER_PACING_MS
	if (!/^(0|[1-9]\d*)$/.test(value)) {
		throw new Error(
			'AIH_VALUE_PATH_PROVIDER_PACING_MS must be a non-negative integer',
		)
	}
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed)) {
		throw new Error(
			'AIH_VALUE_PATH_PROVIDER_PACING_MS must be a safe non-negative integer',
		)
	}
	return parsed
}
