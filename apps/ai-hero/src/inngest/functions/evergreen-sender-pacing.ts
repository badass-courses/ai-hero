import { parseValuePathProviderPacingMs } from './value-path-provider-pacing'

/**
 * The pause between Kit writes in drovr-evergreen-sender-v1.
 *
 * Unset, it is exactly the shared value-path pacing (10 s by default), so
 * adding this knob changes nothing. The evergreen sender writes with the Kit
 * v4 key, one call per send, and at 10 s it drains ~30 sends per 5-minute
 * run whatever AIH_DROVR_EVERGREEN_SENDER_LIMIT says (2026-09-25: 2,266
 * accepted at 16:00Z, ~7 h to drain). Setting it lets the evergreen drain run
 * faster without touching the value-path cron, whose v3 key hit Kit 429s.
 */
export function evergreenSenderPacingMs(
	env: Readonly<Record<string, string | undefined>>,
): number {
	const own = env.AIH_DROVR_EVERGREEN_SENDER_PACING_MS?.trim()
	if (!own)
		return parseValuePathProviderPacingMs(env.AIH_VALUE_PATH_PROVIDER_PACING_MS)
	if (!/^(0|[1-9]\d*)$/.test(own) || !Number.isSafeInteger(Number(own))) {
		throw new Error(
			'AIH_DROVR_EVERGREEN_SENDER_PACING_MS must be a non-negative integer',
		)
	}
	return Number(own)
}
