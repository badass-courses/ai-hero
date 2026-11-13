import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	getUser: vi.fn(),
	ownerAbility: vi.fn(),
	names: vi.fn(),
}))
vi.mock('@/db', () => ({
	db: { query: { deviceAccessToken: { findFirst: mocks.findFirst } } },
}))
vi.mock('@/db/schema', () => ({
	deviceAccessToken: { token: Symbol('device-token') },
}))
vi.mock('../get-user', () => ({ getUser: mocks.getUser }))
vi.mock('@/lib/learner-agent/oauth/client-name', () => ({
	clientNamesFor: mocks.names,
}))
vi.mock('@/server/device-token-grant', () => ({
	DEVICE_ADMIN_SCOPE: 'admin:all',
	DEVICE_CLI_CLIENT: 'aihero-cli',
	deviceOwnerAbility: mocks.ownerAbility,
}))
import { GET } from '../route'
const request = (authorization = 'Bearer device-token') =>
	new Request('http://localhost/oauth/userinfo', {
		headers: { Authorization: authorization },
	})
const row = () => ({
	userId: 'user_1',
	scope: 'learner:read',
	createdAt: new Date(),
	expiresAt: new Date(Date.now() + 60_000),
	revokedAt: null,
})
beforeEach(() => {
	vi.clearAllMocks()
	mocks.getUser.mockResolvedValue({
		id: 'user_1',
		email: 'user@example.test',
		roles: ['admin'],
		fields: { private: true },
	})
	mocks.findFirst.mockResolvedValue(row())
	mocks.names.mockResolvedValue(new Map([['device-token', 'aihero-cli']]))
	mocks.ownerAbility.mockResolvedValue({ can: () => true })
})
describe('oauth userinfo device-token policy', () => {
	it('returns selected identity fields only for learner-read', async () => {
		const response = await GET(request())
		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(await response.json()).toEqual({
			id: 'user_1',
			email: 'user@example.test',
		})
	})
	it.each([
		['null scope', { scope: null }],
		['empty scope', { scope: '' }],
		['whitespace scope', { scope: ' ' }],
		['expired', { expiresAt: new Date(Date.now() - 1000) }],
		['revoked', { revokedAt: new Date() }],
		['analytics', { scope: 'analytics:read' }],
		['unknown', { scope: 'unknown' }],
	])(
		'rejects %s with 401 before loading the user',
		async (_label, overrides) => {
			mocks.findFirst.mockResolvedValue({ ...row(), ...overrides })
			const response = await GET(request())
			expect(response.status).toBe(401)
			expect((await response.json()).error_description).toBe(
				'Your AI Hero login expired. Run `aihero-cli auth login` (or reconnect the MCP) to sign in again.',
			)
			expect(mocks.getUser).not.toHaveBeenCalled()
		},
	)
	it('requires Bearer', async () => {
		expect((await GET(request('Basic device-token'))).status).toBe(401)
		expect(mocks.findFirst).not.toHaveBeenCalled()
	})
	it('accepts a CLI admin and rechecks the role on every use', async () => {
		mocks.findFirst.mockResolvedValue({ ...row(), scope: 'admin:all' })
		expect((await GET(request())).status).toBe(200)
		mocks.ownerAbility.mockResolvedValue({ can: () => false })
		expect((await GET(request())).status).toBe(401)
		mocks.ownerAbility.mockResolvedValue({ can: () => true })
		mocks.names.mockResolvedValue(new Map())
		expect((await GET(request())).status).toBe(401)
	})
})
