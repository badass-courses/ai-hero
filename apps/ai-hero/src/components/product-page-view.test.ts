import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
	auth: vi.fn(),
	schedule: vi.fn(),
	rethrow: vi.fn(),
}))
vi.mock('@/server/auth', () => ({ getServerAuthSession: mocks.auth }))
vi.mock('next/navigation', () => ({ unstable_rethrow: mocks.rethrow }))
vi.mock('@/lib/subscriber-marketing/product-events-live', () => ({
	scheduleProductEvents: mocks.schedule,
}))
import { ProductPageView } from './product-page-view'

beforeEach(() => {
	vi.resetAllMocks()
	vi.stubEnv('AIH_DROVR_PRODUCT_EVENTS_ENABLED', 'true')
})
afterEach(() => vi.unstubAllEnvs())
it('does not read identity or schedule in preview or with the gate off', async () => {
	vi.stubEnv('VERCEL_ENV', 'preview')
	await ProductPageView({ pageId: '/for-your-team' })
	vi.stubEnv('VERCEL_ENV', 'production')
	vi.stubEnv('AIH_DROVR_PRODUCT_EVENTS_ENABLED', 'false')
	await ProductPageView({ pageId: '/for-your-team' })
	expect(mocks.auth).not.toHaveBeenCalled()
	expect(mocks.schedule).not.toHaveBeenCalled()
})
it('only schedules a signed-in teams page view, never anonymous', async () => {
	mocks.auth.mockResolvedValueOnce({ session: null })
	await ProductPageView({ pageId: '/for-your-team' })
	expect(mocks.schedule).not.toHaveBeenCalled()
	mocks.auth.mockResolvedValueOnce({
		session: { user: { email: 'person@example.test' } },
	})
	await ProductPageView({ pageId: '/for-your-team' })
	const [email, facts] = mocks.schedule.mock.calls[0]!
	expect(await email()).toBe('person@example.test')
	expect(facts).toEqual([
		{
			_tag: 'PageViewed',
			page: 'team-pricing',
			pageId: '/for-your-team',
			at: expect.any(Number),
		},
	])
})
it('contains ordinary auth failures but preserves Next dynamic-rendering signals', async () => {
	mocks.auth.mockRejectedValueOnce(new Error('identity unavailable'))
	await expect(
		ProductPageView({ pageId: '/for-your-team' }),
	).resolves.toBeNull()
	const signal = new Error('Next dynamic render')
	mocks.auth.mockRejectedValueOnce(signal)
	mocks.rethrow.mockImplementationOnce((error) => {
		throw error
	})
	await expect(ProductPageView({ pageId: '/for-your-team' })).rejects.toBe(
		signal,
	)
})
