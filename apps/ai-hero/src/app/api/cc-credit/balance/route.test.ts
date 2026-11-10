import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
	enabled: false,
	auth: vi.fn(),
	scopes: vi.fn(),
	balance: vi.fn(),
}))
vi.mock('@/server/auth', () => ({ getServerAuthSession: mocks.auth }))
vi.mock('@/lib/cc-credit/runtime', () => ({
	creditEnabled: () => mocks.enabled,
	creditStore: {},
	signedInOrganizationScopes: mocks.scopes,
}))
vi.mock('@/lib/cc-credit/service', () => ({ readCreditBalance: mocks.balance }))
import { GET } from './route'

beforeEach(() => {
	vi.clearAllMocks()
	mocks.enabled = true
	mocks.auth.mockResolvedValue({ session: { user: { id: 'user_synthetic' } } })
	mocks.scopes.mockResolvedValue([
		{ organizationId: 'org_synthetic', stripeCustomerId: '' },
	])
	mocks.balance.mockResolvedValue({
		seats: 2,
		amountCents: 20000,
		currency: 'usd',
	})
})
describe('private signed-in CC balance', () => {
	it('reads nothing while the feature is off', async () => {
		mocks.enabled = false
		expect((await GET()).status).toBe(204)
		expect(mocks.auth).not.toHaveBeenCalled()
		expect(mocks.balance).not.toHaveBeenCalled()
	})
	it('rejects signed-out callers without querying any scope', async () => {
		mocks.auth.mockResolvedValue({ session: null })
		expect((await GET()).status).toBe(401)
		expect(mocks.scopes).not.toHaveBeenCalled()
	})
	it('derives scopes only from the session and returns only aggregated amounts, never source/customer ids', async () => {
		const result = await GET()
		expect(mocks.scopes).toHaveBeenCalledWith('user_synthetic')
		expect(await result.json()).toEqual({
			seats: 2,
			amountCents: 20000,
			currency: 'usd',
		})
		expect(result.headers.get('cache-control')).toBe('private, no-store')
		expect(result.headers.get('vary')).toBe('Cookie')
	})
	it('returns unavailable, not a zero balance, on a ledger failure', async () => {
		mocks.balance.mockRejectedValue(new Error('missing table'))
		const result = await GET()
		expect(result.status).toBe(503)
		expect(await result.json()).toEqual({ state: 'unavailable' })
	})
})
