/** One gate for profileAck registration, completion and tombstones. Same
 * bounded fail-closed decision as C5; no env switch or cached enablement. */
export const PROFILE_ACK_FLAG_READ_TIMEOUT_MS = 500
const timedOut = Symbol('profile-ack-flag-read-timed-out')
export async function profileAckFlagEnabled(args: {
	readFlag(): Promise<unknown>
	timeoutMs?: number
}): Promise<boolean> {
	const timeoutMs = args.timeoutMs ?? PROFILE_ACK_FLAG_READ_TIMEOUT_MS
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)
		return false
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const value = await Promise.race([
			args.readFlag(),
			new Promise<typeof timedOut>((resolve) => {
				timer = setTimeout(() => resolve(timedOut), timeoutMs)
			}),
		])
		return value === true || value === 'true' || value === '1' || value === 1
	} catch {
		return false
	} finally {
		clearTimeout(timer)
	}
}
