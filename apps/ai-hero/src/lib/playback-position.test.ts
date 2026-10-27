import { describe, expect, it } from 'vitest'

import { getResumeStartTime } from './playback-position'

describe('getResumeStartTime', () => {
	it('resumes a save from the middle of the video', () => {
		expect(getResumeStartTime({ savedTime: 272, duration: 600 })).toBe(272)
	})

	it('restarts without a save', () => {
		expect(getResumeStartTime({ savedTime: null, duration: 600 })).toBe(0)
		expect(getResumeStartTime({ savedTime: undefined, duration: 600 })).toBe(0)
	})

	it('restarts a save from the first 5 seconds', () => {
		expect(getResumeStartTime({ savedTime: 4, duration: 600 })).toBe(0)
		expect(getResumeStartTime({ savedTime: 5, duration: 600 })).toBe(5)
	})

	it('restarts inside the last 5% of a long video', () => {
		// 5% of 600 s is 30 s, larger than 10 s: the tail starts at 570.
		expect(getResumeStartTime({ savedTime: 569, duration: 600 })).toBe(569)
		expect(getResumeStartTime({ savedTime: 570, duration: 600 })).toBe(0)
	})

	it('restarts inside the last 10 seconds of a short video', () => {
		// 5% of 120 s is 6 s, smaller than 10 s: the tail starts at 110.
		expect(getResumeStartTime({ savedTime: 109, duration: 120 })).toBe(109)
		expect(getResumeStartTime({ savedTime: 110, duration: 120 })).toBe(0)
	})

	it('restarts a save past the end', () => {
		expect(getResumeStartTime({ savedTime: 700, duration: 600 })).toBe(0)
	})

	it('keeps the save when the duration is unknown', () => {
		expect(getResumeStartTime({ savedTime: 90, duration: NaN })).toBe(90)
		expect(getResumeStartTime({ savedTime: 90, duration: Infinity })).toBe(90)
		expect(getResumeStartTime({ savedTime: 90, duration: 0 })).toBe(90)
	})
})
