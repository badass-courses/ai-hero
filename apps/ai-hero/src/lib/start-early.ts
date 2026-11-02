/**
 * Starts a read now so it runs alongside slower work, and returns its promise
 * to await where the value is used.
 *
 * Awaiting the returned promise rejects exactly as awaiting the read would, so
 * the caller's failure handling is unchanged. What it adds is a handled mark:
 * if the slower work throws first (a 404, a failed loader) and this promise is
 * never awaited, its rejection is dropped instead of surfacing as an
 * unhandled rejection.
 */
export function startEarly<T>(read: () => Promise<T>): Promise<T> {
	const pending = read()
	pending.catch(() => {})
	return pending
}
