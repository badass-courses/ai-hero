import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	find: vi.fn(),
	set: vi.fn(),
	where: vi.fn(),
	ownerAbility: vi.fn(),
}))
vi.mock('@/db', () => ({
	db: {
		query: { deviceVerifications: { findFirst: mocks.find } },
		update: () => ({
			set: (values: unknown) => {
				mocks.set(values)
				return { where: mocks.where }
			},
		}),
	},
}))
vi.mock('@/server/auth', () => ({ getServerAuthSession: mocks.session }))
vi.mock('@/server/device-token-grant', async (original) => ({
	...(await original<typeof import('@/server/device-token-grant')>()),
	deviceOwnerAbility: mocks.ownerAbility,
}))
vi.mock('@/server/logger', () => ({
	log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
import { mintDeviceCode, mintDeviceConsent } from '@/server/device-token-grant'
import { deviceVerificationRouter } from './device-verification'
let deviceCode: string
const verify = (
	consent = mintDeviceConsent('test-code', deviceCode, 'u1') ?? 'invalid',
) =>
	deviceVerificationRouter
		.createCaller({ headers: new Headers() } as any)
		.verify({ userCode: 'test-code', consent })
beforeEach(() => {
	vi.clearAllMocks()
	mocks.ownerAbility.mockResolvedValue({ can: () => true })
	mocks.where.mockResolvedValue([{ affectedRows: 1 }, []])
	deviceCode = mintDeviceCode({ clientName: 'aihero-cli', scope: 'admin:all' })!
	mocks.session.mockResolvedValue({
		session: { user: { id: 'u1' } },
		ability: { can: () => true },
	})
	mocks.find.mockImplementation(async () => ({
		deviceCode,
		expires: new Date(Date.now() + 60_000),
		verifiedAt: null,
	}))
})
describe('device scope approval', () => {
	it('requires the current approving admin role, not a stale session role', async () => {
		mocks.ownerAbility.mockResolvedValue({ can: () => false })
		expect(await verify()).toEqual({ status: 'scope-denied' })
		expect(mocks.set).not.toHaveBeenCalled()
	})
	it('records the approving admin only after explicit matching consent', async () => {
		expect(await verify()).toEqual({ status: 'device-verified' })
		expect(mocks.set).toHaveBeenCalledWith({
			verifiedAt: expect.any(Date),
			verifiedByUserId: 'u1',
		})
	})
	it('refuses a code that differs from what the approval page showed', async () => {
		const other = mintDeviceCode({
			clientName: 'learner-device',
			scope: 'learner:read',
		})!
		expect(await verify(mintDeviceConsent('test-code', other, 'u1')!)).toEqual({
			status: 'scope-denied',
		})
		expect(mocks.set).not.toHaveBeenCalled()
	})
	it('reports an approval race lost to another approver', async () => {
		mocks.where.mockResolvedValueOnce([{ affectedRows: 0 }, []])
		expect(await verify()).toEqual({ status: 'already-verified' })
	})
	it('refuses a consent ticket issued to a different signed-in user', async () => {
		expect(
			await verify(mintDeviceConsent('test-code', deviceCode, 'other-user')!),
		).toEqual({ status: 'scope-denied' })
		expect(mocks.set).not.toHaveBeenCalled()
	})
	it('refuses an old unbound device code', async () => {
		deviceCode = 'legacy-uuid'
		expect(await verify()).toEqual({ status: 'scope-denied' })
		expect(mocks.set).not.toHaveBeenCalled()
	})
	it('allows a learner to approve only learner-read', async () => {
		deviceCode = mintDeviceCode({
			clientName: 'learner-device',
			scope: 'learner:read',
		})!
		mocks.session.mockResolvedValue({
			session: { user: { id: 'u1' } },
			ability: { can: () => false },
		})
		expect(await verify()).toEqual({ status: 'device-verified' })
		expect(mocks.ownerAbility).not.toHaveBeenCalled()
	})
})
