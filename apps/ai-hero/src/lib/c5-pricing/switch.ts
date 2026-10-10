/**
 * Whether C5 is closed. C5 opens only when the `c5-pricing-enabled` admin flag
 * is on and the `AIH_C5_PRICING_DISABLED` override is not set. The override
 * wins without a flag read. A flag read that fails, throws or outlasts
 * `timeoutMs` closes C5; it never opens it.
 */
export type C5SwitchDeps = {
	/** The env override. On, C5 is closed whatever the flag says. */
	readonly envDisabled: () => boolean
	/** The flag's stored value; null when it was never set. */
	readonly readFlag: () => Promise<unknown>
	/** The flag's value when it was never set, for this environment. */
	readonly flagDefault: boolean
	readonly timeoutMs: number
}

export const C5_FLAG_TIMEOUT_MS = 500

const TIMED_OUT = Symbol('timed-out')

/** The flag's stored value as a boolean; anything unrecognized is off. */
export function flagIsOn(value: unknown, flagDefault: boolean): boolean {
	if (value === null || value === undefined) return flagDefault
	return value === true || value === 'true' || value === '1' || value === 1
}

export async function c5Closed(deps: C5SwitchDeps): Promise<boolean> {
	if (deps.envDisabled()) return true
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const value = await Promise.race([
			deps.readFlag(),
			new Promise<typeof TIMED_OUT>((resolve) => {
				timer = setTimeout(() => resolve(TIMED_OUT), deps.timeoutMs)
			}),
		])
		if (value === TIMED_OUT) return true
		return !flagIsOn(value, deps.flagDefault)
	} catch {
		return true
	} finally {
		clearTimeout(timer)
	}
}
