import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	signIn: vi.fn(),
	limit: vi.fn(),
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: { getPurchaseUserTransferById: mocks.get },
}))
vi.mock('next/headers', () => ({
	headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.9' }),
}))
vi.mock('@/server/logger', () => ({ log: { error: vi.fn() } }))
vi.mock('@/server/redis-client', () => ({ redis: {} }))
vi.mock('@upstash/ratelimit', () => ({
	Ratelimit: Object.assign(
		class {
			limit = mocks.limit
		},
		{ slidingWindow: vi.fn() },
	),
}))
vi.mock('@/server/auth', () => ({ signIn: mocks.signIn }))

import { sendTransferLogin } from './actions'

describe('sendTransferLogin', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.limit.mockResolvedValue({ success: true })
	})

	it('emails the recipient resolved on the server, back to the transfer', async () => {
		mocks.get.mockResolvedValue({
			id: 'tr_1',
			transferState: 'INITIATED',
			purchase: { userId: 'source' },
			targetUserId: 'target',
			targetUser: { email: 'pat@home.example' },
		})
		await expect(sendTransferLogin('tr_1')).resolves.toEqual({ sent: true })
		expect(mocks.signIn).toHaveBeenCalledWith('postmark', {
			email: 'pat@home.example',
			redirectTo: '/transfer/tr_1',
			redirect: false,
		})
	})

	it.each(['CANCELED', 'EXPIRED', 'COMPLETED', 'AVAILABLE'])(
		'sends nothing for a %s transfer',
		async (transferState) => {
			mocks.get.mockResolvedValue({
				id: 'tr_1',
				purchase: { userId: 'source' },
				transferState,
				targetUser: { email: 'pat@home.example' },
			})
			await expect(sendTransferLogin('tr_1')).resolves.toEqual({ sent: false })
			expect(mocks.signIn).not.toHaveBeenCalled()
		},
	)

	it('sends nothing when there is no recipient', async () => {
		mocks.get.mockResolvedValue({
			transferState: 'INITIATED',
			targetUser: null,
		})
		await expect(sendTransferLogin('tr_1')).resolves.toEqual({ sent: false })
	})

	it('sends nothing for an INITIATED transfer past its time', async () => {
		mocks.get.mockResolvedValue({
			id: 'tr_1',
			purchase: { userId: 'source' },
			transferState: 'INITIATED',
			expiresAt: new Date(Date.now() - 1000),
			targetUser: { email: 'pat@home.example' },
		})
		await expect(sendTransferLogin('tr_1')).resolves.toEqual({ sent: false })
	})

	it('sends nothing once the purchase has moved to the recipient', async () => {
		mocks.get.mockResolvedValue({
			id: 'tr_1',
			purchase: { userId: 'target' },
			transferState: 'VERIFIED',
			targetUserId: 'target',
			targetUser: { email: 'pat@home.example' },
		})
		await expect(sendTransferLogin('tr_1')).resolves.toEqual({ sent: false })
	})

	it('sends nothing when the rate limit is hit', async () => {
		mocks.limit.mockResolvedValue({ success: false })
		mocks.get.mockResolvedValue({
			id: 'tr_1',
			purchase: { userId: 'source' },
			transferState: 'INITIATED',
			targetUser: { email: 'pat@home.example' },
		})
		await expect(sendTransferLogin('tr_1')).resolves.toEqual({ sent: false })
		expect(mocks.signIn).not.toHaveBeenCalled()
	})
})
