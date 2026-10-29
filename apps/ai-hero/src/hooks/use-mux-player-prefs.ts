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
			// Loading cues for captions that stay off is not the viewer's choice.
			if (subtitles.some((track) => primingCaptionTracks.has(track))) return

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

/**
 * Empties the caption tracks when the live lesson player starts a new source.
 * The one `<mux-player>` swaps `playbackId` across lessons, and its text
 * tracks outlive the swap: cues the outgoing video left behind keep showing
 * under the new video's, as two overlapping subtitle lines.
 */
export const clearStaleCaptions = (
	muxPlayerRef: React.RefObject<MuxPlayerRefAttributes | null>,
) => {
	for (const track of Array.from(muxPlayerRef.current?.textTracks ?? [])) {
		if (track.kind !== 'subtitles' && track.kind !== 'captions') continue
		for (const cue of Array.from(track.cues ?? [])) track.removeCue(cue)
	}
}

const primingCaptionTracks = new WeakSet<TextTrack>()
const primedCaptionSources = new WeakMap<TextTrack, string>()

/**
 * Keeps the caption track's cues loading while captions are off, for
 * features that read them (the session panel's spoken highlight). Mux's
 * playback-core asks hls.js for a subtitle playlist only when a track turns
 * `showing`, so a merely `hidden` track never gets cues in browsers that play
 * through hls.js. Showing it until playback-core has handled the change
 * selects the playlist (no cue has loaded yet, so nothing appears), and
 * hls.js keeps loading it after the track goes back to `hidden`. Once per
 * source; never while the viewer has captions on, and never saved as their
 * preference.
 *
 * Call it again whenever the tracks change; returns nothing to clean up.
 */
export const keepCaptionCuesLoading = (
	player: MuxPlayerRefAttributes | null | undefined,
) => {
	const tracks = player?.media?.nativeEl?.textTracks ?? player?.textTracks
	const track = Array.from(tracks ?? []).find(
		(track) => track.kind === 'subtitles' || track.kind === 'captions',
	)
	if (!track || !tracks || primingCaptionTracks.has(track)) return
	if (track.mode === 'disabled') track.mode = 'hidden'

	const source = player?.playbackId ?? ''
	if (
		track.mode !== 'hidden' ||
		track.cues?.length ||
		primedCaptionSources.get(track) === source ||
		getPlayerPrefs().subtitle.mode === 'showing'
	)
		return

	primedCaptionSources.set(track, source)
	primingCaptionTracks.add(track)
	track.mode = 'showing'
	// playback-core reacts to this same `change` event; hide the track on the
	// next task, after it has selected the playlist. The flag clears after
	// the `change` that hiding fires, which earlier listeners (the saved
	// preference) have then already skipped.
	setTimeout(() => {
		if (track.mode !== 'showing') {
			primingCaptionTracks.delete(track)
			return
		}
		track.mode = 'hidden'
		tracks.addEventListener(
			'change',
			() => primingCaptionTracks.delete(track),
			{ once: true },
		)
	}, 0)
}
