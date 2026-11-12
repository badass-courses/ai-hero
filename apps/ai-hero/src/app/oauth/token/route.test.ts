import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	verification: vi.fn(),
	tokenFindFirst: vi.fn(),
	insertValues: vi.fn(),
	deleteWhere: vi.fn(),
	ownerAbility: vi.fn(),
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
vi.mock('@/server/device-token-grant', async (original) => ({
	...(await original<typeof import('@/server/device-token-grant')>()),
	deviceOwnerAbility: mocks.ownerAbility,
}))
vi.mock('@/lib/learner-agent/oauth/grant', () => ({
	exchangeAuthorizationCode: mocks.codeGrant,
}))
import { mintDeviceCode } from '@/server/device-token-grant'
import { POST } from './route'

let deviceCode: string
const exchange = (fields: Record<string, string> = {}) =>
	POST(
		new Request('https://aihero.test/oauth/token', {
			method: 'POST',
			body: new URLSearchParams({ device_code: deviceCode, ...fields }),
		}),
	)
beforeEach(() => {
	vi.clearAllMocks()
	deviceCode = mintDeviceCode({
		clientName: 'learner-device',
		scope: 'learner:read',
	})!
	mocks.verification.mockImplementation(async () => ({
		deviceCode,
		verifiedAt: new Date(),
		verifiedByUserId: 'u1',
		expires: new Date(Date.now() + 60_000),
	}))
	mocks.ownerAbility.mockResolvedValue({ can: () => false })
	mocks.insertValues.mockResolvedValue(undefined)
	mocks.tokenFindFirst.mockImplementation(async () => ({
		token: mocks.insertValues.mock.calls[0]?.[0]?.token,
	}))
})

describe('device-code exchange', () => {
	it.each<Record<string, string>>([{}, { client_id: 'unknown' }])(
		'defaults to learner-read without a known client or scope: %j',
		async (fields) => {
			const before = Date.now()
			const response = await exchange(fields)
			expect(response.status).toBe(200)
			const inserted = mocks.insertValues.mock.calls[0]?.[0]
			expect(inserted).toMatchObject({
				userId: 'u1',
				token: expect.any(String),
				scope: 'learner:read',
				clientName: 'learner-device',
				revokedAt: null,
			})
			expect(inserted.expiresAt.getTime() - before).toBeGreaterThanOrEqual(
				90 * 24 * 3600_000,
			)
			expect(inserted.expiresAt.getTime() - before).toBeLessThan(
				90 * 24 * 3600_000 + 1000,
			)
			expect(await response.json()).toMatchObject({
				scope: 'learner:read',
				expires_in: 90 * 24 * 3600,
			})
		},
	)
	it('fails the mint if the atomic insert cannot write the client label', async () => {
		mocks.insertValues.mockRejectedValueOnce(
			new Error('INSERT token=secret missing clientName column'),
		)
		const response = await exchange()
		expect(response.status).toBe(500)
		expect(await response.text()).not.toContain('secret')
		expect(mocks.deleteWhere).not.toHaveBeenCalled()
	})

	it('stores a repeated learner scope once', async () => {
		expect(
			(await exchange({ scope: ' learner:read learner:read ' })).status,
		).toBe(200)
		expect(mocks.insertValues.mock.calls[0]?.[0].scope).toBe('learner:read')
	})
	it.each(['admin:all', 'content:write'])(
		'cannot escalate at exchange to %s',
		async (scope) => {
			const response = await exchange({ client_id: 'aihero-cli', scope })
			expect(response.status).toBe(400)
			expect(mocks.insertValues).not.toHaveBeenCalled()
		},
	)
	it('refuses admin scope for a non-admin even on the known client', async () => {
		deviceCode = mintDeviceCode({
			clientName: 'aihero-cli',
			scope: 'admin:all',
		})!
		const response = await exchange({
			client_id: 'aihero-cli',
			scope: 'admin:all',
		})
		expect(response.status).toBe(403)
		expect(await response.json()).toMatchObject({ error: 'access_denied' })
		expect(mocks.insertValues).not.toHaveBeenCalled()
	})
	it('mints explicit admin scope only for a still-admin approving owner', async () => {
		deviceCode = mintDeviceCode({
			clientName: 'aihero-cli',
			scope: 'admin:all',
		})!
		mocks.ownerAbility.mockResolvedValue({ can: () => true })
		expect(
			(await exchange({ client_id: 'aihero-cli', scope: 'admin:all' })).status,
		).toBe(200)
		expect(mocks.insertValues.mock.calls[0]?.[0]).toMatchObject({
			scope: 'admin:all',
			clientName: 'aihero-cli',
			expiresAt: expect.any(Date),
		})
	})
	it.each(['legacy-uuid', 'aih_dev_tampered'])(
		'rejects unbound or manipulated codes: %s',
		async (device_code) => {
			expect((await exchange({ device_code })).status).toBe(400)
			expect(mocks.verification).not.toHaveBeenCalled()
			expect(mocks.insertValues).not.toHaveBeenCalled()
		},
	)
	it('answers authorization_pending before approval', async () => {
		mocks.verification.mockResolvedValue({
			deviceCode,
			verifiedAt: null,
			expires: new Date(Date.now() + 60_000),
		})
		expect(await (await exchange()).json()).toMatchObject({
			error: 'authorization_pending',
		})
	})
	it('rejects expired codes even after approval', async () => {
		mocks.verification.mockResolvedValue({
			deviceCode,
			verifiedAt: new Date(),
			expires: new Date(Date.now() - 1),
		})
		expect(await (await exchange()).json()).toMatchObject({
			error: 'expired_token',
		})
		expect(mocks.insertValues).not.toHaveBeenCalled()
	})
	it('routes only authorization_code to the code grant', async () => {
		mocks.codeGrant.mockResolvedValue(new Response('{}'))
		await exchange({ grant_type: 'authorization_code', code: 'c' })
		expect(mocks.codeGrant).toHaveBeenCalledOnce()
		expect(mocks.verification).not.toHaveBeenCalled()
	})
	it('keeps the explicit device grant', async () => {
		expect(
			(
				await exchange({
					grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
				})
			).status,
		).toBe(200)
	})
	it.each([
		[{ 'content-type': 'application/json' }, '{}'],
		[{}, undefined],
	] as const)('rejects non-form bodies', async (headers, body) => {
		const response = await POST(
			new Request('https://aihero.test/oauth/token', {
				method: 'POST',
				headers,
				body,
			}),
		)
		expect(response.status).toBe(400)
		expect(mocks.verification).not.toHaveBeenCalled()
	})
})
