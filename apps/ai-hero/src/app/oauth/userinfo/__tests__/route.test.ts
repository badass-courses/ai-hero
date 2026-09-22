import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	getUser: vi.fn(),
}))

vi.mock('@/db', () => ({
	db: { query: { deviceAccessToken: { findFirst: mocks.findFirst } } },
}))
vi.mock('@/db/schema', () => ({
	deviceAccessToken: { token: Symbol('device-token') },
}))
vi.mock('../get-user', () => ({ getUser: mocks.getUser }))

import { GET } from '../route'

const request = (authorization = 'Bearer device-token') =>
	new Request('http://localhost/oauth/userinfo', {
		headers: { Authorization: authorization },
	})

beforeEach(() => {
	vi.clearAllMocks()
	mocks.getUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' })
	mocks.findFirst.mockResolvedValue({
		userId: 'user_1',
		createdAt: new Date(),
		expiresAt: new Date(Date.now() + 60_000),
		revokedAt: null,
	})
})

describe('oauth userinfo device-token policy', () => {
	it('returns the existing user payload for an active token', async () => {
		const response = await GET(request())

		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(await response.json()).toEqual({
			id: 'user_1',
			email: 'user@example.com',
		})
		expect(mocks.getUser).toHaveBeenCalledWith('user_1')
	})

	it('does not expose a scoped credential through userinfo', async () => {
		mocks.findFirst.mockResolvedValue({
			userId: 'user_1',
			scope: 'analytics:read',
			createdAt: new Date(),
			expiresAt: new Date(Date.now() + 60_000),
			revokedAt: null,
		})

		const response = await GET(request('Bearer device-token'))

		expect(response.status).toBe(404)
		expect(mocks.getUser).not.toHaveBeenCalled()
	})

	it.each([
		['expired', { expiresAt: new Date(Date.now() - 1_000) }],
		['revoked', { revokedAt: new Date() }],
		['unknown scope', { scope: 'admin:all' }],
	])('rejects an %s token before loading the user', async (_label, overrides) => {
		mocks.findFirst.mockResolvedValue({
			userId: 'user_1',
			createdAt: new Date(),
			expiresAt: new Date(Date.now() + 60_000),
			revokedAt: null,
			...overrides,
		})

		const response = await GET(request())

		expect(response.status).toBe(404)
		expect(mocks.getUser).not.toHaveBeenCalled()
	})
})
