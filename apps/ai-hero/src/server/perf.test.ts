import { afterEach, describe, expect, it, vi } from 'vitest'

import { log } from '@/server/logger'
import { sampleTimings } from '@/server/perf'

describe('sampleTimings', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('logs once after the requested parts finish', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.019)
		const info = vi.spyOn(log, 'info').mockResolvedValue(undefined)
		const now = vi.spyOn(performance, 'now').mockReturnValue(10)
		const timings = sampleTimings<'wrapperTotal' | 'transcript'>('perf.test')

		const wrapper = timings.measure('wrapperTotal', async () => 'page')
		now.mockReturnValue(14)
		await expect(wrapper).resolves.toBe('page')
		timings.finish({ signedIn: false }, ['wrapperTotal', 'transcript'])
		expect(info).not.toHaveBeenCalled()

		const transcript = timings.measure('transcript', async () => null)
		now.mockReturnValue(21)
		await expect(transcript).resolves.toBeNull()
		timings.finish({ signedIn: false }, ['wrapperTotal', 'transcript'])
		expect(info).toHaveBeenCalledOnce()
		expect(info).toHaveBeenCalledWith('perf.test', {
			wrapperTotal: 4,
			transcript: 7,
			signedIn: false,
		})
	})

	it.each([
		[0.02, undefined],
		[0, 0],
		[0.02, Number.NaN],
	])('skips the clock and log at random=%s and rate=%s', (random, rate) => {
		vi.spyOn(Math, 'random').mockReturnValue(random)
		const now = vi.spyOn(performance, 'now')
		const info = vi.spyOn(log, 'info').mockResolvedValue(undefined)
		const timings = sampleTimings('perf.test', rate)
		const result = Promise.resolve('page')

		expect(timings.measure('wrapperTotal', () => result)).toBe(result)
		timings.finish({}, ['wrapperTotal'])
		expect(now).not.toHaveBeenCalled()
		expect(info).not.toHaveBeenCalled()
	})

	it('drops a sample if the clock throws without losing the operation result', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.5)
		vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockImplementation(() => {
			throw new Error('clock unavailable')
		})
		const info = vi.spyOn(log, 'info').mockResolvedValue(undefined)
		const timings = sampleTimings('perf.test', 1)
		timings.finish({}, ['wrapperTotal'])

		await expect(timings.measure('wrapperTotal', async () => 'page')).resolves.toBe('page')
		expect(info).not.toHaveBeenCalled()
	})

	it('keeps the original failure if the telemetry sink rejects', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0)
		const info = vi.spyOn(log, 'info').mockRejectedValue(new Error('sink unavailable'))
		const timings = sampleTimings('perf.test')
		timings.finish({}, ['wrapperTotal'])
		const failure = new Error('operation failed')

		await expect(timings.measure('wrapperTotal', () => Promise.reject(failure))).rejects.toBe(failure)
		expect(info).toHaveBeenCalledOnce()
	})
})
