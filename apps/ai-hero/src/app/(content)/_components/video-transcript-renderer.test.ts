// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { playTranscriptTimestamp } from './video-transcript-renderer'

describe('playTranscriptTimestamp', () => {
	it('seeks and scrolls the video section into view', () => {
		const section = document.createElement('section')
		section.setAttribute('aria-label', 'video')
		section.scrollIntoView = vi.fn()

		const player = document.createElement('div')
		const play = vi.fn(() => Promise.resolve())
		Object.assign(player, { currentTime: 0, play })
		section.append(player)

		playTranscriptTimestamp(player as never, '1:23')

		expect((player as unknown as { currentTime: number }).currentTime).toBe(83)
		expect(play).toHaveBeenCalledOnce()
		expect(section.scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
	})
})
