/**
 * Default-on compatibility mirror. This does not control enrolment or consent,
 * or writes to Total TypeScript's separately owned Kit account.
 * Turn off only after Kit send/automation readers have been retired.
 */
export function kitMirrorWritesEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return !['false', 'off', '0'].includes(
		(env.AIH_KIT_MIRROR_WRITES_ENABLED ?? '').trim().toLowerCase(),
	)
}
