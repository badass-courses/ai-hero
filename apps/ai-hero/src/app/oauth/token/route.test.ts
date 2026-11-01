import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	verification: vi.fn(),
	tokenFindFirst: vi.fn(),
	insertValues: vi.fn(),
	deleteWhere: vi.fn(),
	getUser: vi.fn(),
	codeGrant: vi.fn(),
}))

vi.mock('@/db', () => ({
	db: {
		query: {
			deviceVerifications: { findFirst: mocks.verification },
			deviceAccessToken: { findFirst: mocks.tokenFindFirst },
		},
		insert: () => ({ values: mocks.insertValues }),
		delete: () => ({ where: mocks.deleteWhere }),
	},
}))
vi.mock('@/db/schema', () => ({
	deviceAccessToken: { token: Symbol('token') },
	deviceVerifications: { deviceCode: Symbol('deviceCode') },
}))
vi.mock('@/app/oauth/userinfo/get-user', () => ({ getUser: mocks.getUser }))
vi.mock('@/lib/learner-agent/oauth/grant', () => ({
	exchangeAuthorizationCode: mocks.codeGrant,
}))

import { POST } from './route'

const exchange = (fields: Record<string, string>) => {
	const body = new FormData()
	for (const [key, value] of Object.entries(fields)) body.set(key, value)
	return POST(
		new Request('https://aihero.test/oauth/token', { method: 'POST', body }),
	)
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.verification.mockResolvedValue({
		deviceCode: 'code-1',
		verifiedAt: new Date(),
		verifiedByUserId: 'u1',
		expires: new Date(Date.now() + 60_000),
	})
	mocks.getUser.mockResolvedValue({ id: 'u1' })
	mocks.insertValues.mockResolvedValue(undefined)
	mocks.tokenFindFirst.mockImplementation(async () => ({
		token: mocks.insertValues.mock.calls[0]?.[0]?.token,
	}))
})

describe('device-code exchange', () => {
	it('mints today’s unscoped token when no scope is asked for', async () => {
		const response = await exchange({ device_code: 'code-1' })
		expect(response.status).toBe(200)
		const inserted = mocks.insertValues.mock.calls[0]?.[0]
		expect(inserted).toEqual({ userId: 'u1', token: expect.any(String) })
		expect(await response.json()).toMatchObject({
			token_type: 'bearer',
			scope: 'content:read progress',
		})
	})

	it('narrows to learner:read with a 90-day expiry when asked', async () => {
		const before = Date.now()
		const response = await exchange({
			device_code: 'code-1',
			scope: 'learner:read',
		})
		expect(response.status).toBe(200)
		const inserted = mocks.insertValues.mock.calls[0]?.[0]
		expect(inserted).toMatchObject({ userId: 'u1', scope: 'learner:read' })
		const ttl = (inserted.expiresAt as Date).getTime() - before
		expect(ttl).toBeGreaterThan(89 * 24 * 3600_000)
		expect(ttl).toBeLessThanOrEqual(90 * 24 * 3600_000 + 1000)
		expect(await response.json()).toMatchObject({ scope: 'learner:read' })
	})

	it('stores a repeated scope once, so the learner can list and revoke it', async () => {
		const response = await exchange({
			device_code: 'code-1',
			scope: ' learner:read   learner:read ',
		})
		expect(response.status).toBe(200)
		expect(mocks.insertValues.mock.calls[0]?.[0]).toMatchObject({
			scope: 'learner:read',
		})
		expect(await response.json()).toMatchObject({ scope: 'learner:read' })
	})

	it('refuses a scope it cannot narrow to, and mints nothing', async () => {
		const response = await exchange({
			device_code: 'code-1',
			scope: 'admin:all',
		})
		expect(response.status).toBe(400)
		expect(await response.json()).toMatchObject({ error: 'invalid_scope' })
		expect(mocks.insertValues).not.toHaveBeenCalled()
	})

	it('still answers authorization_pending before approval', async () => {
		mocks.verification.mockResolvedValue({
			deviceCode: 'code-1',
			verifiedAt: null,
			expires: new Date(Date.now() + 60_000),
		})
		const response = await exchange({
			device_code: 'code-1',
			scope: 'learner:read',
		})
		expect(response.status).toBe(403)
		expect(await response.json()).toMatchObject({
			error: 'authorization_pending',
		})
	})

	it('keeps the device flow for an explicit device_code grant_type', async () => {
		const response = await exchange({
			grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
			device_code: 'code-1',
		})
		expect(response.status).toBe(200)
		expect(mocks.codeGrant).not.toHaveBeenCalled()
		expect(mocks.insertValues.mock.calls[0]?.[0]).toEqual({
			userId: 'u1',
			token: expect.any(String),
		})
	})

	it('sends only grant_type=authorization_code to the code grant', async () => {
		mocks.codeGrant.mockResolvedValue(new Response('{}', { status: 200 }))
		await exchange({ grant_type: 'authorization_code', code: 'c' })
		expect(mocks.codeGrant).toHaveBeenCalledTimes(1)
		expect(mocks.verification).not.toHaveBeenCalled()
		expect(mocks.insertValues).not.toHaveBeenCalled()
	})
})
