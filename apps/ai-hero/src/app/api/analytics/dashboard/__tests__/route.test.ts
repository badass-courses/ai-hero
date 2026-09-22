import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getServerAuthSession: vi.fn(),
	loadDashboardSection: vi.fn(),
	log: { error: vi.fn() },
}))

vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))
vi.mock('@/lib/analytics/dashboard-sections', () => ({
	DASHBOARD_SECTIONS: [
		'summary',
		'revenue',
		'attribution',
		'shortlinks',
		'traffic',
		'mux',
		'surveys',
		'value-paths',
	],
	loadDashboardSection: mocks.loadDashboardSection,
}))
vi.mock('@/server/logger', () => ({
	log: mocks.log,
	createRequestContext: vi.fn(() => ({})),
	serializeError: vi.fn((error: unknown) =>
		error instanceof Error ? error.message : String(error),
	),
	withLogContext: vi.fn(async (_context: unknown, fn: () => Promise<unknown>) =>
		fn(),
	),
}))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))

import { GET } from '../route'

const request = (query: string) =>
	new NextRequest(`http://localhost:3000/api/analytics/dashboard?${query}`)

const authorized = {
	session: { user: { id: 'admin_1' } },
	ability: { can: vi.fn(() => true) },
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.getServerAuthSession.mockResolvedValue(authorized)
	mocks.loadDashboardSection.mockResolvedValue({
		summary: { totalRevenue: 199, purchaseCount: 1, avgOrderValue: 199 },
	})
})

describe('analytics dashboard section route', () => {
	it('rejects an unauthorized section before running a provider', async () => {
		mocks.getServerAuthSession.mockResolvedValue({
			session: null,
			ability: { can: vi.fn(() => false) },
		})

		const response = await GET(request('section=summary&range=30d'))

		expect(response.status).toBe(401)
		expect(response.headers.get('cache-control')).toBe('private, no-store')
		expect(mocks.loadDashboardSection).not.toHaveBeenCalled()
	})

	it('returns a ready section and keeps the response private', async () => {
		const response = await GET(request('section=summary&range=7d'))

		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toBe('private, no-store')
		expect(mocks.loadDashboardSection).toHaveBeenCalledWith(
			'summary',
			'7d',
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		)
		expect(await response.json()).toMatchObject({
			ok: true,
			section: 'summary',
			range: '7d',
			data: { summary: { totalRevenue: 199 } },
		})
	})

	it('returns a visible section failure instead of a successful zero', async () => {
		mocks.loadDashboardSection.mockRejectedValueOnce(new Error('database EOF'))

		const response = await GET(request('section=shortlinks&range=30d'))
		const body = await response.json()

		expect(response.status).toBe(503)
		expect(body).toMatchObject({
			ok: false,
			section: 'shortlinks',
			error: {
				code: 'SECTION_UNAVAILABLE',
				message: expect.stringContaining('unavailable'),
			},
		})
		expect(JSON.stringify(body)).not.toContain('database EOF')
	})

	it('rejects unknown sections and invalid ranges', async () => {
		const unknown = await GET(request('section=not-a-section&range=30d'))
		const invalidRange = await GET(request('section=summary&range=tomorrow'))

		expect(unknown.status).toBe(400)
		expect(invalidRange.status).toBe(400)
		expect(mocks.loadDashboardSection).not.toHaveBeenCalled()
	})
})
