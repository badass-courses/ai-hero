import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ closed: true }))
vi.mock('@/lib/c5-pricing/switch-server', () => ({
	c5PricingClosed: vi.fn(async () => state.closed),
}))

import { dynamic, GET } from './route'

describe('read-only C5 promo eligibility', () => {
	it.each([true, false])(
		'reads the existing pricing switch: closed=%s',
		async (closed) => {
			state.closed = closed
			const response = await GET()
			expect(await response.json()).toEqual({ pricingClosed: closed })
			expect(response.headers.get('cache-control')).toBe('no-store')
			expect(dynamic).toBe('force-dynamic')
		},
	)
})
