import type { DrovrShadowEvent } from './drovr-shadow-emitter'

/**
 * No bulk value-path births between 201e PR A's deploy (by 10-18) and PR B's
 * (the spread window W raised, at least 7 days later): at W = 30 with
 * anchored drips every wave is concentrated (the hawk, 201e S2 guard 1).
 * The paced bulk lane refuses them in that window unless the hawk signs off.
 *
 * - FROM: PR A's deploy, 10-18 at the latest. Set
 *   `AIH_DROVR_VALUE_PATH_BULK_FREEZE=on` if PR A deploys earlier.
 * - UNTIL: null until PR B deploys; PR B sets it to its deploy instant.
 * - A sign-off (`AIH_DROVR_VALUE_PATH_BULK_SIGNOFF`, the hawk's name and
 *   the date) lets one import through; unset it after.
 */
export const DROVR_VALUE_PATH_BULK_FREEZE = {
	from: '2026-10-18T00:00:00.000Z',
	until: null as string | null,
}

export type ValuePathBulkFreeze =
	{ frozen: false; signedOffBy?: string } | { frozen: true; reason: string }

export function valuePathBulkFreeze(
	env: Record<string, string | undefined>,
	nowMs: number,
	window: { from: string; until: string | null } = DROVR_VALUE_PATH_BULK_FREEZE,
): ValuePathBulkFreeze {
	const flag = env.AIH_DROVR_VALUE_PATH_BULK_FREEZE?.trim() === 'on'
	const inWindow =
		nowMs >= Date.parse(window.from) &&
		(window.until === null || nowMs < Date.parse(window.until))
	if (!flag && !inWindow) return { frozen: false }
	const signOff = env.AIH_DROVR_VALUE_PATH_BULK_SIGNOFF?.trim()
	if (signOff) return { frozen: false, signedOffBy: signOff }
	return {
		frozen: true,
		reason: flag
			? 'AIH_DROVR_VALUE_PATH_BULK_FREEZE is on'
			: `201e window: from ${window.from}${window.until ? ` until ${window.until}` : ' until PR B'}`,
	}
}

/** A birth into a value-path journey: what the freeze refuses in bulk. */
export const isValuePathBirth = (event: DrovrShadowEvent) =>
	event.type === 'contact.created' && event.journeyId.startsWith('value-path-')
