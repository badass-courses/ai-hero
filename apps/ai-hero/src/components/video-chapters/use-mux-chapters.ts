import * as React from 'react'
import type { MuxPlayerRefAttributes } from '@mux/mux-player-react'

import type { VideoChapter } from '@coursebuilder/core/schemas'

import { toMuxChapters } from './chapter-utils'

type PlayerWithAddChapters = MuxPlayerRefAttributes & {
	addChapters?: (
		chapters: { startTime: number; value: string; endTime?: number }[],
	) => Promise<TextTrack> | TextTrack | void
	removeTextTrack?: (track: TextTrack) => void
	textTracks?: TextTrackList
	readyState?: number
	addEventListener?: HTMLMediaElement['addEventListener']
	removeEventListener?: HTMLMediaElement['removeEventListener']
}

function getMuxChaptersTrack(player: PlayerWithAddChapters) {
	return Array.from(player.textTracks ?? []).find(
		(track) => track.kind === 'chapters' && track.label === 'chapters',
	)
}

export function clearMuxChapters(
	player: PlayerWithAddChapters,
	chaptersTrackRef: React.MutableRefObject<TextTrack | null>,
) {
	if (typeof player.removeTextTrack !== 'function') return

	const track = chaptersTrackRef.current ?? getMuxChaptersTrack(player)
	if (!track) return

	try {
		player.removeTextTrack(track)
		chaptersTrackRef.current = null
	} catch (err) {
		console.warn('Failed to remove Mux chapters', err)
	}
}

export async function replaceMuxChapters(
	player: PlayerWithAddChapters,
	chapters: VideoChapter[],
	chaptersTrackRef: React.MutableRefObject<TextTrack | null>,
) {
	if (typeof player.addChapters !== 'function') return
	try {
		clearMuxChapters(player, chaptersTrackRef)
		const track = await player.addChapters(toMuxChapters(chapters))
		return track ?? getMuxChaptersTrack(player) ?? null
	} catch (err) {
		console.warn('Failed to add Mux chapters', err)
	}
}

export function useMuxChapters(
	playerRef: React.RefObject<MuxPlayerRefAttributes | null>,
	chapters: VideoChapter[] | null | undefined,
) {
	const chaptersTrackRef = React.useRef<TextTrack | null>(null)
	const replaceIdRef = React.useRef(0)

	React.useEffect(() => {
		const player = playerRef.current as PlayerWithAddChapters | null
		if (!player) return

		const replaceId = replaceIdRef.current + 1
		replaceIdRef.current = replaceId

		const replaceCurrentChapters = async () => {
			if (!chapters?.length) {
				clearMuxChapters(player, chaptersTrackRef)
				return
			}

			const addedTrack = await replaceMuxChapters(
				player,
				chapters,
				chaptersTrackRef,
			)
			if (replaceIdRef.current !== replaceId && addedTrack) {
				player.removeTextTrack?.(addedTrack)
				return
			}
			chaptersTrackRef.current = addedTrack ?? null
		}

		if (typeof player.readyState === 'number' && player.readyState >= 1) {
			void replaceCurrentChapters()
			return () => {
				replaceIdRef.current = replaceId + 1
			}
		}

		if (typeof player.addEventListener !== 'function') return
		const onLoadedMetadata = () => {
			void replaceCurrentChapters()
		}
		player.addEventListener('loadedmetadata', onLoadedMetadata, { once: true })
		return () => {
			player.removeEventListener?.('loadedmetadata', onLoadedMetadata)
			replaceIdRef.current = replaceId + 1
		}
	}, [playerRef, chapters])
}
