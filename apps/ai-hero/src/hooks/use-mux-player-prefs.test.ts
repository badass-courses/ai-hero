import type { MuxPlayerRefAttributes } from '@mux/mux-player-react'
import { describe, expect, it } from 'vitest'

import { setPreferredPlaybackRate } from './use-mux-player-prefs'

describe('setPreferredPlaybackRate', () => {
	it('reapplies the saved rate after the player resets', () => {
		const player = { playbackRate: 1 } as MuxPlayerRefAttributes
		const playerRef = { current: player }

		setPreferredPlaybackRate(playerRef, 1.5)
		expect(player.playbackRate).toBe(1.5)

		player.playbackRate = 1
		setPreferredPlaybackRate(playerRef, 1.5)
		expect(player.playbackRate).toBe(1.5)
	})

	it('does nothing before the player is available', () => {
		const playerRef = { current: null }

		expect(() => setPreferredPlaybackRate(playerRef, 1.5)).not.toThrow()
	})
})
