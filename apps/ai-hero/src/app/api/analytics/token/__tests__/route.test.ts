import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	insertValues: vi.fn(),
	getServerAuthSession: vi.fn(),
	log: { error: vi.fn(), info: vi.fn() },
	deviceAccessToken: { name: 'DeviceAccessToken' },
}))

vi.mock('@/db', () => ({
	db: {
		insert: vi.fn(() => ({ values: mocks.insertValues })),
	},
}))
vi.mock('@/db/schema', () => ({
	deviceAccessToken: mocks.deviceAccessToken,
}))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))

import { POST } from '../route'

const request = () =>
	new NextRequest('http://localhost:3000/api/analytics/token', {
		method: 'POST',
	})

const authorized = {
	session: {
		user: { id: 'admin_1', email: 'admin@example.com' },
	},
	ability: {
		cannot: vi.fn(() => false),
	},
}

describe('analytics token route', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getServerAuthSession.mockResolvedValue(authorized)
		mocks.insertValues.mockResolvedValue(undefined)
	})

	it('denies anonymous minting and never caches credentials', async () => {
		mocks.getServerAuthSession.mockResolvedValue({
			session: null,
			ability: { cannot: vi.fn(() => true) },
		})

		const response = await POST(request())

		expect(response.status).toBe(401)
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(mocks.insertValues).not.toHaveBeenCalled()
	})

	it('persists the advertised expiry and revocation columns', async () => {
		const before = Date.now()
		const response = await POST(request())
		const after = Date.now()
		const body = await response.json()
		const values = mocks.insertValues.mock.calls[0]?.[0]

		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(values).toMatchObject({
			userId: 'admin_1',
			scope: 'analytics:read',
			revokedAt: null,
			token: expect.any(String),
			expiresAt: expect.any(Date),
		})
		expect(body).toMatchObject({
			token: values.token,
			ttlLabel: '90 days',
		expiresAt: expect.any(String),
		})
		expect(values.expiresAt.getTime()).toBeGreaterThanOrEqual(
			before + 90 * 24 * 60 * 60 * 1000,
		)
		expect(values.expiresAt.getTime()).toBeLessThanOrEqual(
			after + 90 * 24 * 60 * 60 * 1000,
		)
	})

	it('returns a safe no-store failure without logging the token or SQL error', async () => {
		mocks.insertValues.mockRejectedValueOnce(
			new Error('INSERT DeviceAccessToken token=secret SQL syntax'),
		)

		const response = await POST(request())
		const body = await response.json()

		expect(response.status).toBe(500)
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(body).toEqual({ error: 'Unable to generate analytics token' })
		expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain('secret')
		expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain('SQL syntax')
	})
})
