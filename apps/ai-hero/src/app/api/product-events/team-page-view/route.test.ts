import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), schedule: vi.fn() }))
vi.mock('@/server/auth', () => ({ getServerAuthSession: mocks.auth }))
vi.mock('@/lib/subscriber-marketing/product-events-live', () => ({
	scheduleProductEvents: mocks.schedule,
}))
import { POST } from './route'

const request = (origin = 'https://aihero.example.test') =>
	new Request('https://aihero.example.test/api/product-events/team-page-view', {
		method: 'POST',
		headers: { origin },
	})
beforeEach(() => {
	vi.resetAllMocks()
	vi.stubEnv('AIH_DROVR_PRODUCT_EVENTS_ENABLED', 'true')
	vi.stubEnv('VERCEL_ENV', 'production')
})
afterEach(() => {
	vi.unstubAllEnvs()
})
it.each(['false', '', 'TRUE'])(
	'no-ops without identity work when gate is %s',
	async (value) => {
		vi.stubEnv('AIH_DROVR_PRODUCT_EVENTS_ENABLED', value)
		expect((await POST(request())).status).toBe(204)
		expect(mocks.auth).not.toHaveBeenCalled()
		expect(mocks.schedule).not.toHaveBeenCalled()
	},
)
it('no-ops on preview and on a cross-origin notification', async () => {
	vi.stubEnv('VERCEL_ENV', 'preview')
	expect((await POST(request())).status).toBe(204)
	vi.stubEnv('VERCEL_ENV', 'production')
	expect((await POST(request('https://other.example.test'))).status).toBe(204)
	expect(mocks.auth).not.toHaveBeenCalled()
})
it('no-ops for anonymous visitors', async () => {
	mocks.auth.mockResolvedValue({ session: null })
	expect((await POST(request())).status).toBe(204)
	expect(mocks.schedule).not.toHaveBeenCalled()
})
it('only schedules the signed-in server identity and fixed teams page, ignoring client fields', async () => {
	mocks.auth.mockResolvedValue({
		session: { user: { email: 'signed-in@example.test' } },
	})
	const response = await POST(
		new Request(request(), {
			body: JSON.stringify({
				email: 'forged@example.test',
				pageId: '/other',
				at: 0,
			}),
		}),
	)
	expect(response.status).toBe(204)
	expect(await response.text()).toBe('')
	const [email, facts] = mocks.schedule.mock.calls[0]!
	expect(await email()).toBe('signed-in@example.test')
	expect(facts).toEqual([
		{
			_tag: 'PageViewed',
			page: 'team-pricing',
			pageId: '/for-your-team',
			at: expect.any(Number),
		},
	])
})
it('contains identity and scheduler errors as an empty 204', async () => {
	mocks.auth.mockRejectedValueOnce(new Error('private'))
	expect((await POST(request())).status).toBe(204)
	mocks.auth.mockResolvedValueOnce({
		session: { user: { email: 'signed-in@example.test' } },
	})
	mocks.schedule.mockImplementationOnce(() => {
		throw new Error('private')
	})
	expect((await POST(request())).status).toBe(204)
})
