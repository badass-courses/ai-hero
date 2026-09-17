import { describe, expect, it } from 'vitest'

import { applyVideoQuality, videoQualityFromSelection } from './use-video-quality-pref'

function list(heights: number[], selectedIndex = -1) {
	const target = new EventTarget() as EventTarget & {
		length: number
		selectedIndex: number
		[index: number]: { height?: number }
	}
	heights.forEach((height, i) => {
		target[i] = { height }
	})
	target.length = heights.length
	target.selectedIndex = selectedIndex
	return target
}

describe('applyVideoQuality', () => {
	it('selects the rung matching the stored height', () => {
		const renditions = list([720, 1080, 1440])
		expect(applyVideoQuality(renditions, 1080)).toBe(true)
		expect(renditions.selectedIndex).toBe(1)
	})

	it('leaves the list alone when the height is missing', () => {
		const renditions = list([720, 1440])
		expect(applyVideoQuality(renditions, 1080)).toBe(false)
		expect(renditions.selectedIndex).toBe(-1)
	})

	it('resets to auto', () => {
		const renditions = list([720, 1080], 1)
		expect(applyVideoQuality(renditions, 'auto')).toBe(true)
		expect(renditions.selectedIndex).toBe(-1)
	})
})

describe('videoQualityFromSelection', () => {
	it('reads the picked height', () => {
		expect(videoQualityFromSelection(list([720, 1080], 1))).toBe(1080)
	})

	it('maps no selection to auto', () => {
		expect(videoQualityFromSelection(list([720, 1080]))).toBe('auto')
	})
})
