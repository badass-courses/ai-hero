/** Retry-After as milliseconds: delay-seconds or an HTTP date. */
export function parseRetryAfterMs(
	header: string | null | undefined,
	nowMs: number,
): number | undefined {
	const value = header?.trim()
	if (!value) return undefined
	if (/^\d+$/.test(value)) return Number(value) * 1000
	const at = Date.parse(value)
	return Number.isNaN(at) ? undefined : Math.max(at - nowMs, 0)
}
