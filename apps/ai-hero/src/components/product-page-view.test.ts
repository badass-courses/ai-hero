import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ effect: vi.fn() }))
vi.mock('react', () => ({ useEffect: mocks.effect }))
import { ProductPageView } from './product-page-view'

beforeEach(() => {
	vi.clearAllMocks()
})
afterEach(() => {
	vi.unstubAllGlobals()
})
it('renders nothing and schedules one fixed-page notification after mount', async () => {
	const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
	vi.stubGlobal('fetch', fetcher)
	expect(ProductPageView()).toBeNull()
	expect(fetcher).not.toHaveBeenCalled()
	expect(mocks.effect).toHaveBeenCalledWith(expect.any(Function), [])
	mocks.effect.mock.calls[0]![0]()
	await Promise.resolve()
	expect(fetcher).toHaveBeenCalledOnce()
	expect(fetcher).toHaveBeenCalledWith('/api/product-events/team-page-view', {
		method: 'POST',
		credentials: 'same-origin',
		keepalive: true,
	})
})
it('contains notification failures without changing navigation', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn().mockRejectedValue(new Error('network unavailable')),
	)
	ProductPageView()
	expect(() => mocks.effect.mock.calls[0]![0]()).not.toThrow()
	await Promise.resolve()
})
