'use client'

import * as React from 'react'
import type { MuxPlayerRefAttributes } from '@mux/mux-player-react'

export type PlayerRef = React.RefObject<MuxPlayerRefAttributes | null> | null

/** The player's current second, updated as it plays and seeks. */
export function usePlayerTime(playerRef: PlayerRef) {
	const [time, setTime] = React.useState(0)
	React.useEffect(() => {
		const player = playerRef?.current
		if (!player) return
		const update = () => setTime(player.currentTime ?? 0)
		update()
		player.addEventListener('timeupdate', update)
		player.addEventListener('seeked', update)
		return () => {
			player.removeEventListener('timeupdate', update)
			player.removeEventListener('seeked', update)
		}
	}, [playerRef])
	return time
}

/** Jumps the video to `seconds` and plays from there. */
export function seekPlayer(playerRef: PlayerRef, seconds: number) {
	const player = playerRef?.current
	if (!player) return
	player.currentTime = seconds
	void player.play()
}

export function formatTime(seconds: number) {
	const whole = Math.floor(seconds)
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}
