import { describe, expect, it, vi } from 'vitest'

import { clearMuxChapters, replaceMuxChapters } from './use-mux-chapters'

function createTrack() {
	return { kind: 'chapters', label: 'chapters' } as TextTrack
}

describe('Mux chapter track helpers', () => {
	it('replaces existing chapters before adding new chapters', async () => {
		const previousTrack = createTrack()
		const nextTrack = createTrack()
		const chaptersTrackRef: { current: TextTrack | null } = {
			current: previousTrack,
		}
		const removeTextTrack = vi.fn()
		const addChapters = vi.fn().mockResolvedValue(nextTrack)

		const result = await replaceMuxChapters(
			{
				addChapters,
				removeTextTrack,
			} as any,
			[{ startTime: 10, title: 'Intro' }],
			chaptersTrackRef,
		)

		expect(removeTextTrack).toHaveBeenCalledWith(previousTrack)
		expect(addChapters).toHaveBeenCalledWith([
			{ startTime: 10, value: 'Intro' },
		])
		expect(result).toBe(nextTrack)
		expect(chaptersTrackRef.current).toBeNull()
	})

	it('clears an existing chapters track when chapters are empty', () => {
		const previousTrack = createTrack()
		const chaptersTrackRef: { current: TextTrack | null } = {
			current: previousTrack,
		}
		const removeTextTrack = vi.fn()

		clearMuxChapters({ removeTextTrack } as any, chaptersTrackRef)

		expect(removeTextTrack).toHaveBeenCalledWith(previousTrack)
		expect(chaptersTrackRef.current).toBeNull()
	})
})
