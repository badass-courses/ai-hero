import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/markdown', () => ({ Markdown: () => null }))
vi.mock('@/hooks/use-mux-player', () => ({ useMuxPlayer: () => ({}) }))

import {
	hmsToSeconds,
	paragraphWithTimestampButtons,
} from './video-transcript-renderer'

function timestampButton(text: string) {
	const html = renderToStaticMarkup(
		paragraphWithTimestampButtons({
			children: text,
			canShowVideo: true,
			muxPlayerRef: null,
		}),
	)
	return { html, label: html.match(/<button[^>]*>([^<]*)<\/button>/)?.[1] }
}

describe('transcript timestamps', () => {
	it('keeps mm:ss timestamps', () => {
		const { html, label } = timestampButton('[02:15] Next we open the file.')
		expect(label).toBe('02:15')
		expect(hmsToSeconds(label)).toBe(135)
		expect(html).toContain('Next we open the file.')
	})

	it('keeps the hour of a timestamp past the first hour', () => {
		const { html, label } = timestampButton('[1:02:03] Back to the plan.')
		expect(label).toBe('1:02:03')
		expect(hmsToSeconds(label)).toBe(3723)
		expect(html).toContain('</button> Back to the plan.')
	})
})
