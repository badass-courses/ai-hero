import { describe, expect, it } from 'vitest'
import { funnelMetricsWindow } from './ads-metrics-window'

describe('funnelMetricsWindow', () => {
	it('uses a true rolling 24 hour window', () => {
		const now = new Date('2026-07-17T18:30:00.000Z')
		const window = funnelMetricsWindow('24h', now)
		expect(window.kind).toBe('rolling')
		expect(window.start.toISOString()).toBe('2026-07-16T18:30:00.000Z')
		expect(window.end.toISOString()).toBe('2026-07-17T18:30:00.000Z')
		expect(window.label).toBe('rolling 24h ending 2026-07-17T18:30:00.000Z')
	})

	it('labels UTC calendar ranges explicitly', () => {
		const window = funnelMetricsWindow('7d', new Date('2026-07-17T18:30:00.000Z'))
		expect(window.start.toISOString()).toBe('2026-07-11T00:00:00.000Z')
		expect(window.label).toBe('2026-07-11 through 2026-07-17 (UTC)')
		expect(window.timeZone).toBe('UTC')
	})
})
