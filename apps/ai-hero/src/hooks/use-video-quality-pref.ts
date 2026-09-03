import * as React from 'react'
import { useMuxPlayer } from '@/hooks/use-mux-player'
import {
	getPlayerPrefs,
	type VideoQualityPreference,
} from '@/lib/mux-player-prefs'
import type { MuxPlayerRefAttributes } from '@mux/mux-player-react'

type RenditionLike = { height?: number }
type RenditionListLike = EventTarget & {
	length: number
	selectedIndex: number
	[index: number]: RenditionLike
}

/**
 * Select the rendition whose height matches the preference.
 * Returns true when a matching rung exists and is now selected.
 * 'auto' resets the list so hls.js picks the rung itself.
 */
export function applyVideoQuality(
	renditions: RenditionListLike,
	quality: VideoQualityPreference,
): boolean {
	if (quality === 'auto') {
		if (renditions.selectedIndex !== -1) renditions.selectedIndex = -1
		return true
	}
	for (let i = 0; i < renditions.length; i++) {
		if (renditions[i]?.height === quality) {
			if (renditions.selectedIndex !== i) renditions.selectedIndex = i
			return true
		}
	}
	return false
}

/** Read the viewer's current pick off the list after a menu change. */
export function videoQualityFromSelection(
	renditions: RenditionListLike,
): VideoQualityPreference {
	const height = renditions[renditions.selectedIndex]?.height
	return renditions.selectedIndex === -1 || typeof height !== 'number'
		? 'auto'
		: height
}

/**
 * Keep the quality menu choice global across videos.
 *
 * Bind the returned handler to `onLoadedMetadata`. Mux adds renditions to
 * `videoRenditions` when the HLS manifest parses, before `loadedmetadata`,
 * so the stored height is applied right away and again whenever a rung
 * appears later. A viewer pick in the menu is persisted to the prefs cookie.
 */
export function useVideoQualityPref(
	playerRef: React.RefObject<MuxPlayerRefAttributes | null>,
) {
	const { setPlayerPrefs } = useMuxPlayer()
	const boundRef = React.useRef<RenditionListLike | null>(null)
	const applyingRef = React.useRef(false)

	return React.useCallback(() => {
		const renditions = playerRef.current?.videoRenditions as
			| RenditionListLike
			| undefined
		if (!renditions || boundRef.current === renditions) return
		boundRef.current = renditions

		const apply = () => {
			applyingRef.current = true
			try {
				applyVideoQuality(renditions, getPlayerPrefs().videoQuality)
			} finally {
				applyingRef.current = false
			}
		}

		renditions.addEventListener('addrendition', apply)
		renditions.addEventListener('change', () => {
			if (applyingRef.current) return
			setPlayerPrefs({ videoQuality: videoQualityFromSelection(renditions) })
		})
		apply()
	}, [playerRef, setPlayerPrefs])
}
