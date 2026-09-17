import cookies from '@coursebuilder/utils/cookies'

export const MUX_PLAYER_PREFS_KEY = 'muxplayer-react-prefs'

export const defaultSubtitlePreference = {
	id: null,
	kind: null,
	label: null,
	language: null,
	mode: 'disabled',
} as const

export type Subtitle = {
	id: string | null
	kind: string | null
	label: string | null
	language: string | null
	mode: string
}

export type PlayerPrefs = {
	volume: number
	playbackRate: number
	autoplay: boolean
	/**
	 * When true, Mux Player requests `min_resolution=480p` so the 480p HLS
	 * rung is in the playlist. Default false keeps the 540p floor, which on
	 * current Crash Course assets means 720p is the lowest available stream.
	 */
	allowLowResolution: boolean
	/**
	 * Rendition height the viewer picked in the quality menu (e.g. 1080), or
	 * 'auto' to let the ABR ladder decide. Reapplied on every player mount.
	 */
	videoQuality: VideoQualityPreference
	subtitle: Subtitle
}

export type VideoQualityPreference = number | 'auto'

/** Floor the player keeps unless the viewer opts into 480p. */
export const MUX_DEFAULT_MIN_RESOLUTION = '540p' as const
/** Lowest Mux Player minResolution that still includes the 480p HLS rung. */
export const MUX_LOW_MIN_RESOLUTION = '480p' as const

export type MuxMinResolution =
	| typeof MUX_DEFAULT_MIN_RESOLUTION
	| typeof MUX_LOW_MIN_RESOLUTION

export const defaultPlayerPreferences: PlayerPrefs = {
	volume: 1,
	playbackRate: 1,
	autoplay: false,
	allowLowResolution: false,
	videoQuality: 'auto',
	subtitle: defaultSubtitlePreference,
}

/**
 * Map player prefs to the Mux Player `minResolution` prop.
 *
 * Opt-in is required because the 540p floor exists so screen-share code
 * stays readable. Existing cookies without the field stay on the floor.
 */
export function muxMinResolutionForPrefs(prefs: {
	allowLowResolution?: boolean
}): MuxMinResolution {
	return prefs.allowLowResolution
		? MUX_LOW_MIN_RESOLUTION
		: MUX_DEFAULT_MIN_RESOLUTION
}

export const getPlayerPrefs = (): PlayerPrefs => {
	if (typeof window === 'undefined') {
		return defaultPlayerPreferences
	}
	const stored = cookies.get(MUX_PLAYER_PREFS_KEY) as
		| Partial<PlayerPrefs>
		| undefined
	if (!stored) {
		return cookies.set(MUX_PLAYER_PREFS_KEY, defaultPlayerPreferences)
	}
	return {
		...defaultPlayerPreferences,
		...stored,
		allowLowResolution: stored.allowLowResolution === true,
		videoQuality:
			typeof stored.videoQuality === 'number' ? stored.videoQuality : 'auto',
		subtitle: {
			...defaultPlayerPreferences.subtitle,
			...stored.subtitle,
		},
	}
}

export const savePlayerPrefs = (options: Partial<PlayerPrefs>): PlayerPrefs => {
	return cookies.set(
		MUX_PLAYER_PREFS_KEY,
		{
			...defaultPlayerPreferences,
			...getPlayerPrefs(),
			...options,
		},
		{ sameSite: 'None', secure: true },
	)
}
