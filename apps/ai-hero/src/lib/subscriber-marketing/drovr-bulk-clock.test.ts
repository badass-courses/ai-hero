import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bulkClockBounds, probeDrovrBulkClock } from './drovr-bulk-clock'
const state = vi.hoisted(() => ({ mono: 0, query: vi.fn(), release: vi.fn() }))
vi.mock('@/db', () => ({
	acquireDatabaseConnection: async () => ({
		query: state.query,
		release: state.release,
	}),
}))
beforeEach(() => {
	state.mono = 0
	vi.clearAllMocks()
	vi.spyOn(performance, 'now').mockImplementation(() => state.mono)
})
afterEach(() => {
	vi.restoreAllMocks()
})
it('samples UTC without a table or session mutation and projects conservative RTT/rounding bounds on monotonic time', async () => {
	state.query.mockImplementation(async () => {
		state.mono += 20
		return [[{ now: '1956528000000' }]]
	})
	const sample = await probeDrovrBulkClock()
	expect(sample).toMatchObject({
		utcMs: 1956528000000,
		rttMs: 20,
		monotonicAt: 20,
		precisionMs: 1,
	})
	expect(state.query).toHaveBeenCalledOnce()
	expect(state.query.mock.calls[0]![0]).toContain('UTC_TIMESTAMP(6)')
	expect(state.query.mock.calls[0]![0]).not.toMatch(/\b(SET|FROM|UPDATE)\b/i)
	state.mono += 40
	expect(bulkClockBounds(sample)).toEqual({
		lower: 1956528000040,
		upper: 1956528000061,
	})
	expect(state.release).toHaveBeenCalledOnce()
})
it('releases the connection when the clock query fails', async () => {
	state.query.mockRejectedValueOnce(
		new Error('synthetic clock query unavailable'),
	)
	await expect(probeDrovrBulkClock()).rejects.toThrow(
		'synthetic clock query unavailable',
	)
	expect(state.release).toHaveBeenCalledOnce()
})
it('retains the full one-sided RTT uncertainty at the approved250ms boundary', () => {
	const sample = {
		utcMs: 1000,
		rttMs: 250,
		monotonicAt: 0,
		precisionMs: 1,
		monotonicNow: () => 25,
	}
	expect(bulkClockBounds(sample)).toEqual({ lower: 1025, upper: 1276 })
})
it('rejects slow, invalid or backwards samples rather than consulting app wall time', () => {
	const sample = { utcMs: 1000, rttMs: 0, monotonicAt: 0, precisionMs: 1 }
	expect(bulkClockBounds({ ...sample, rttMs: 251 })).toBeUndefined()
	expect(bulkClockBounds({ ...sample, utcMs: NaN })).toBeUndefined()
	expect(bulkClockBounds({ ...sample, monotonicAt: 1 })).toBeUndefined()
})
