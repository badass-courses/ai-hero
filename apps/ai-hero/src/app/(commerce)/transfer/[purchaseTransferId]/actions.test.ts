import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ get: vi.fn(), signIn: vi.fn() }))
vi.mock('@/db', () => ({
	courseBuilderAdapter: { getPurchaseUserTransferById: mocks.get },
}))
vi.mock('@/server/auth', () => ({ signIn: mocks.signIn }))

import { sendTransferLogin } from './actions'

describe('sendTransferLogin', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('emails the recipient resolved on the server, back to the transfer', async () => {
		mocks.get.mockResolvedValue({
			transferState: 'INITIATED',
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
})
