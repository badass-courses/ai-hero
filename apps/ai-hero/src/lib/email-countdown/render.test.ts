import { GifReader } from 'omggif'
import { describe, expect, it } from 'vitest'
import { HEIGHT, PALETTE, renderCountdownGif, WIDTH } from './render'

function decode(gif: Uint8Array) {
	const reader = new GifReader(gif)
	return {
		reader,
		frames: Array.from({ length: reader.numFrames() }, (_, i) =>
			reader.frameInfo(i),
		),
	}
}

describe('renderCountdownGif', () => {
	it('is a valid GIF89a with 60 one-second frames that plays once', () => {
		const gif = renderCountdownGif(16 * 3600 + 29 * 60 + 59)
		expect(new TextDecoder().decode(gif.subarray(0, 6))).toBe('GIF89a')

		const { reader, frames } = decode(gif)
		expect(reader.width).toBe(WIDTH)
		expect(reader.height).toBe(HEIGHT)
		expect(frames).toHaveLength(60)
		expect(frames.every((frame) => frame.delay === 100)).toBe(true)
		// No Netscape loop block, so clients play it once and hold the last frame.
		expect(reader.loopCount()).toBeNull()
		expect(gif.byteLength).toBeLessThan(150 * 1024)
	})

	it('draws the whole image first, then only the digits that change', () => {
		const { frames } = decode(renderCountdownGif(5 * 86400 + 30))
		expect(frames[0]).toMatchObject({
			x: 0,
			y: 0,
			width: WIDTH,
			height: HEIGHT,
		})
		for (const frame of frames.slice(1)) {
			expect(frame.width).toBeLessThan(WIDTH)
			expect(frame.disposal).toBe(1)
		}
	})

	it('ends on the zero frame when until falls inside the minute', () => {
		expect(decode(renderCountdownGif(3)).frames).toHaveLength(4)
	})

	it('is a single static frame at or past until', () => {
		expect(decode(renderCountdownGif(0)).frames).toHaveLength(1)
	})

	it('uses an eight-colour palette', () => {
		expect(PALETTE).toHaveLength(8)
		expect(new Set(PALETTE).size).toBe(8)
	})

	it('changes the pixels between the first and last frame', () => {
		const { reader, frames } = decode(renderCountdownGif(100))
		const first = new Uint8Array(WIDTH * HEIGHT * 4)
		const last = new Uint8Array(WIDTH * HEIGHT * 4)
		reader.decodeAndBlitFrameRGBA(0, first)
		last.set(first)
		for (let i = 1; i < frames.length; i++) {
			reader.decodeAndBlitFrameRGBA(i, last)
		}
		expect(Buffer.compare(first, last)).not.toBe(0)
	})
})
