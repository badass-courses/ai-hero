import { describe, expect, it, vi } from 'vitest'

import {
	createPlaybackPositionSaveQueue,
	mergePlaybackPositionFields,
	readPlaybackPosition,
} from './playback-position'

describe('lesson playback position', () => {
	it('stores playback time without replacing other progress fields', () => {
		const fields = mergePlaybackPositionFields({ note: 'keep-me' }, 42.8)

		expect(fields).toEqual({
			note: 'keep-me',
			playbackPositionSeconds: 42,
		})
		expect(readPlaybackPosition(fields)).toBe(42)
	})

	it('serializes writes so an older request cannot overwrite the final position', async () => {
		let releaseFirst: (() => void) | undefined
		const firstWrite = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const saved: number[] = []
		const save = vi.fn(async (position: number) => {
			if (position === 30) await firstWrite
			saved.push(position)
		})
		const queue = createPlaybackPositionSaveQueue(save)

		const first = queue(30)
		const final = queue(0)
		expect(save).toHaveBeenCalledTimes(1)

		releaseFirst?.()
		await Promise.all([first, final])

		expect(saved).toEqual([30, 0])
	})
})
