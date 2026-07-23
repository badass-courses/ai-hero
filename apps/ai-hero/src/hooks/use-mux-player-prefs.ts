import * as React from 'react'
import {
	getPlayerPrefs,
	savePlayerPrefs,
	type PlayerPrefs,
	type Subtitle,
} from '@/lib/mux-player-prefs'
import type { MuxPlayerRefAttributes } from '@mux/mux-player-react'

/**
 * Hook for managing Mux Player preferences
 * @returns Object containing player preferences and methods to update them
 */
export const useMuxPlayerPrefs = () => {
	const [playerPrefs, setPlayerPrefs] =
		React.useState<PlayerPrefs>(getPlayerPrefs())

	const setPlayerPrefsOptions = React.useCallback(
		(options: Partial<PlayerPrefs>) => {
			console.debug('setting player prefs', { options })
			const newPrefs = savePlayerPrefs(options)
			setPlayerPrefs(newPrefs)
		},
		[],
	)

	return {
		setPlayerPrefs: setPlayerPrefsOptions,
		getPlayerPrefs: React.useCallback(getPlayerPrefs, []),
		...playerPrefs,
	}
}

/**
 * Reapplies the preferred playback rate after the media element resets
 */
export const setPreferredPlaybackRate = (
	muxPlayerRef: React.RefObject<MuxPlayerRefAttributes | null>,
	playbackRate: number,
) => {
	if (
		muxPlayerRef.current &&
		muxPlayerRef.current.playbackRate !== playbackRate
	) {
		muxPlayerRef.current.playbackRate = playbackRate
	}
}

/**
 * Sets the preferred text track on the Mux Player
 */
export const setPreferredTextTrack = (
	muxPlayerRef: React.RefObject<MuxPlayerRefAttributes | null>,
) => {
	if (muxPlayerRef.current) {
		const player = muxPlayerRef.current
		const preferredTextTrack = player.textTracks?.getTrackById(
			getPlayerPrefs().subtitle.id ?? '',
		)
		if (preferredTextTrack && getPlayerPrefs().subtitle.mode === 'showing') {
			preferredTextTrack.mode = 'showing'
		}
	}
}

/**
 * Handles text track changes and updates player preferences
 */
export const handleTextTrackChange = (
	muxPlayerRef: React.RefObject<MuxPlayerRefAttributes | null>,
	setPlayerPrefs: (e: { subtitle: Subtitle }) => void,
) => {
	if (muxPlayerRef.current) {
		const player = muxPlayerRef.current
		player?.textTracks?.addEventListener('change', () => {
			const subtitles = Array.from(player.textTracks || []).filter((track) => {
				return ['subtitles'].includes(track.kind)
			})

			subtitles.forEach((textTrack) => {
				setPlayerPrefs({
					subtitle: {
						id: textTrack.id,
						kind: textTrack.kind,
						label: textTrack.label,
						language: textTrack.language,
						mode: textTrack.mode,
					},
				})
			})
		})
	}
}
