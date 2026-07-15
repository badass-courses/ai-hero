import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getAdsCourseMetrics: vi.fn(),
	getUserAbilityForRequest: vi.fn(),
	getServerAuthSession: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/lib/ads-course-metrics', () => ({ getAdsCourseMetrics: mocks.getAdsCourseMetrics }))
vi.mock('@/server/ability-for-request', () => ({ getUserAbilityForRequest: mocks.getUserAbilityForRequest }))
vi.mock('@/server/auth', () => ({ getServerAuthSession: mocks.getServerAuthSession }))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/server/with-skill', () => ({ withSkill: (handler: unknown) => handler }))

import { GET } from '../route'

const request = (query = '') => new NextRequest(`http://localhost:3000/api/analytics/ads-course${query}`)
const auth = (action: 'manage' | 'view') => ({
	user: { id: 'user_1', email: 'team@example.com' },
	ability: { can: vi.fn((candidate: string, subject: string) => action === 'manage' ? candidate === 'manage' && subject === 'all' : candidate === 'view' && subject === 'Analytics') },
})

describe('ads-course analytics API', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getServerAuthSession.mockResolvedValue({ session: null, ability: { can: vi.fn(() => false) } })
		mocks.getAdsCourseMetrics.mockResolvedValue({ ads: { totals: { costUsd: 12, signups: 3, costPerSignupUsd: 4 } }, funnel: { stages: { signups: { range: 3, total: 10 } } } })
	})

	it('rejects unauthenticated reads', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue({ user: null, ability: null })
		const response = await GET(request())
		expect(response.status).toBe(401)
		expect(await response.json()).toMatchObject({ ok: false, error: { code: 'AUTH_REQUIRED' } })
	})

	it.each(['manage', 'view'] as const)('allows %s analytics access', async (role) => {
		mocks.getUserAbilityForRequest.mockResolvedValue(auth(role))
		const response = await GET(request('?productId=email-course&range=today'))
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({ ok: true, surface: 'ads-course', productId: 'email-course', range: 'today', data: { ads: { totals: { signups: 3, costPerSignupUsd: 4 } } } })
		expect(mocks.getAdsCourseMetrics).toHaveBeenCalledWith({ productId: 'email-course', range: 'today' })
	})

	it('rejects unsupported ranges before querying providers', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(auth('manage'))
		const response = await GET(request('?range=all'))
		expect(response.status).toBe(400)
		expect(await response.json()).toMatchObject({ ok: false, error: { code: 'INVALID_RANGE' } })
		expect(mocks.getAdsCourseMetrics).not.toHaveBeenCalled()
	})
})
