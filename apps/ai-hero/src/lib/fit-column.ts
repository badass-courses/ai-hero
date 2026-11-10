/**
 * Cuts a request header value to its varchar column length. MySQL refuses an
 * over-long value (errno 1406) and the whole row is lost, so a 600-character
 * referrer used to drop a progress save or a shortlink click.
 */
export function fitColumn(
	value: string | null | undefined,
	length: number,
): string | undefined {
	if (value == null) return undefined
	return value.length > length ? value.slice(0, length) : value
}

/** Column lengths shared by the referrer and user-agent attribution columns. */
export const REFERRER_LENGTH = 500
export const USER_AGENT_LENGTH = 500
