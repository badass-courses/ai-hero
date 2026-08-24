import { type PlayerPrefs } from './mux-player-prefs'

/** UserPrefs.type for the account-level Mux playback opt-in. */
export const PLAYBACK_PREF_TYPE = 'playback'

export type PlaybackPrefFields = {
	allowLowResolution: boolean
}

export type PlaybackPrefRecord = PlaybackPrefFields & {
	/** False when this user has no UserPrefs playback row yet. */
	stored: boolean
}

/**
 * Parse UserPrefs.fields for the playback row.
 * Anything other than explicit `true` stays on the 540p floor.
 */
export function parsePlaybackPrefFields(fields: unknown): PlaybackPrefFields {
	const record =
		fields && typeof fields === 'object'
			? (fields as Record<string, unknown>)
			: {}
	return {
		allowLowResolution: record.allowLowResolution === true,
	}
}

/**
 * Build the tRPC payload from a UserPrefs row.
 * Missing rows keep the cookie as the device cache.
 */
export function playbackPrefRecordFromRow(
	row: { fields: unknown } | undefined,
): PlaybackPrefRecord {
	return {
		...parsePlaybackPrefFields(row?.fields),
		stored: row !== undefined,
	}
}

/**
 * Overlay the durable playback flag onto cookie-backed player prefs.
 * Volume, rate, and autoplay stay device-local.
 */
export function applyPlaybackPrefToPlayerPrefs<T extends PlayerPrefs>(
	playerPrefs: T,
	playback: PlaybackPrefFields,
): T {
	return {
		...playerPrefs,
		allowLowResolution: playback.allowLowResolution,
	}
}
