import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getRecentPaidPurchases: vi.fn(),
	getServerAuthSession: vi.fn(),
}))

vi.mock('@/lib/admin-sales-globe', async (importOriginal) => {
	const original =
		await importOriginal<typeof import('@/lib/admin-sales-globe')>()
	return {
		...original,
		getRecentPaidPurchases: mocks.getRecentPaidPurchases,
	}
})

vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))

import { GET } from '../route'

const request = (query = '') =>
	new NextRequest(`http://localhost:3000/api/admin/globe/purchases${query}`)

function auth({ admin }: { admin: boolean }) {
	return {
		session: { user: { id: 'user_1', email: 'admin@example.com' } },
		ability: {
			can: vi.fn((action: string, subject: string) =>
				admin
					? action === 'manage' && subject === 'all'
					: action === 'view' && subject === 'Analytics',
			),
		},
	}
}

describe('admin sales globe purchases API', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getRecentPaidPurchases.mockResolvedValue([])
	})

	it('returns 401 for an anonymous request', async () => {
		mocks.getServerAuthSession.mockResolvedValue({
			session: null,
			ability: { can: vi.fn(() => false) },
		})

		const response = await GET(request())

		expect(response.status).toBe(401)
		expect(mocks.getRecentPaidPurchases).not.toHaveBeenCalled()
	})

	it('returns 403 for an analytics-only user', async () => {
		mocks.getServerAuthSession.mockResolvedValue(auth({ admin: false }))

		const response = await GET(request())

		expect(response.status).toBe(403)
		expect(mocks.getRecentPaidPurchases).not.toHaveBeenCalled()
	})

	it('returns serialized recent purchases for an admin with no-store headers', async () => {
		mocks.getServerAuthSession.mockResolvedValue(auth({ admin: true }))
		mocks.getRecentPaidPurchases.mockResolvedValue([
			{
				id: 'purchase_1',
				createdAt: new Date('2026-08-21T17:00:00.123Z'),
				amount: 199,
				productName: 'AI Coding Crash Course',
				productId: 'product_1',
				country: 'US',
				userName: 'Ada',
				userEmail: 'ada@example.com',
				userImage: null,
				isTeam: false,
				seats: null,
			},
		])

		const response = await GET(request('?limit=500'))

		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toBe('private, no-store')
		expect(mocks.getRecentPaidPurchases).toHaveBeenCalledWith({ limit: 100 })
		expect(await response.json()).toMatchObject({
			purchases: [
				{
					id: 'purchase_1',
					createdAt: '2026-08-21T17:00:00.123Z',
				},
			],
		})
	})

	it('uses the default limit when the query value is invalid', async () => {
		mocks.getServerAuthSession.mockResolvedValue(auth({ admin: true }))

		await GET(request('?limit=nope'))

		expect(mocks.getRecentPaidPurchases).toHaveBeenCalledWith({ limit: 50 })
	})
})
