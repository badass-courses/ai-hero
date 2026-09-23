import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getPurchase: vi.fn(),
	getUserById: vi.fn(),
	findMany: vi.fn(),
	findOrCreate: vi.fn(),
	update: vi.fn(),
	set: vi.fn(),
	where: vi.fn(),
	sendEmail: vi.fn(),
	directTransfer: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
}))

vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		getPurchase: mocks.getPurchase,
		getUserById: mocks.getUserById,
		transferPurchaseToUser: mocks.directTransfer,
	},
	db: {
		query: { purchaseUserTransfer: { findMany: mocks.findMany } },
		update: mocks.update,
	},
}))
vi.mock('@/db/schema', () => ({
	purchaseUserTransfer: {
		id: 'id', purchaseId: 'purchaseId', sourceUserId: 'sourceUserId',
		transferState: 'transferState',
	},
}))
vi.mock('drizzle-orm', () => ({
	and: (...args: unknown[]) => args,
	eq: (...args: unknown[]) => args,
	inArray: (...args: unknown[]) => args,
}))
vi.mock('@/env.mjs', () => ({
	env: { NEXT_PUBLIC_URL: 'https://www.aihero.dev', COURSEBUILDER_URL: 'https://www.aihero.dev' },
}))
vi.mock('@/lib/find-or-create-user', () => ({
	findOrCreateUserWithPersonalOrg: mocks.findOrCreate,
}))
vi.mock('@/coursebuilder/email-provider', () => ({ emailProvider: { id: 'test' } }))
vi.mock('@/server/auth', () => ({ authOptions: {} }))
vi.mock('@/server/logger', () => ({ log: { info: mocks.info, error: mocks.error } }))
vi.mock('@coursebuilder/email/send-server-email', () => ({ sendServerEmail: mocks.sendEmail }))
vi.mock('@/purchase-transfer/transfer-email', () => ({
	transferEmailHtml: vi.fn(), transferEmailText: vi.fn(),
}))

import { initiateSupportPurchaseTransfer, inspectSupportPurchaseTransfer } from './support-initiate'

const input = {
	purchaseId: 'purch-1',
	sourceUserId: 'buyer-1',
	targetEmail: 'Learner@Example.com',
}
const available = {
	id: 'transfer-1', purchaseId: 'purch-1', sourceUserId: 'buyer-1',
	transferState: 'AVAILABLE', expiresAt: new Date('2099-01-01'),
}

describe('support purchase transfer invitation', () => {
	beforeEach(() => {
		vi.resetAllMocks()
		mocks.getPurchase.mockResolvedValue({ id: 'purch-1', userId: 'buyer-1', status: 'Valid' })
		mocks.getUserById.mockResolvedValue({ id: 'buyer-1', email: 'buyer@example.com' })
		mocks.findMany.mockResolvedValue([available])
		mocks.findOrCreate.mockResolvedValue({ user: { id: 'learner-1', email: 'learner@example.com' } })
		mocks.where.mockResolvedValue({ rowsAffected: 1 })
		mocks.set.mockReturnValue({ where: mocks.where })
		mocks.update.mockReturnValue({ set: mocks.set })
	})

	it('invites the recipient through the existing acceptance flow, without moving ownership', async () => {
		const result = await initiateSupportPurchaseTransfer(input)
		expect(result).toEqual({ state: 'invited', transferId: 'transfer-1' })
		expect(mocks.findOrCreate).toHaveBeenCalledWith('learner@example.com')
		expect(mocks.set).toHaveBeenCalledWith({ targetUserId: 'learner-1', transferState: 'INITIATED' })
		expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
			email: 'learner@example.com',
			callbackUrl: 'https://www.aihero.dev/transfer/transfer-1',
			type: 'transfer',
		}))
		expect(mocks.directTransfer).not.toHaveBeenCalled()
	})

	it('preflights read-only before provisioning a target', async () => {
		const result = await inspectSupportPurchaseTransfer(input)
		expect(result).toEqual({ state: 'ready', transferId: 'transfer-1', expiresAt: available.expiresAt, targetEmail: 'learner@example.com' })
		expect(mocks.findOrCreate).not.toHaveBeenCalled()
		expect(mocks.update).not.toHaveBeenCalled()
		expect(mocks.sendEmail).not.toHaveBeenCalled()
	})

	it('denies a non-owner before creating a target or sending mail', async () => {
		mocks.getPurchase.mockResolvedValue({ id: 'purch-1', userId: 'somebody-else', status: 'Valid' })
		expect(await initiateSupportPurchaseTransfer(input)).toEqual({
			state: 'blocked', reason: 'not_purchase_owner',
		})
		expect(mocks.findOrCreate).not.toHaveBeenCalled()
		expect(mocks.sendEmail).not.toHaveBeenCalled()
	})

	it('refuses another in-flight transfer without emailing again', async () => {
		mocks.findMany.mockResolvedValue([{ ...available, transferState: 'INITIATED' }])
		expect(await initiateSupportPurchaseTransfer(input)).toEqual({
			state: 'blocked', reason: 'transfer_in_flight',
		})
		expect(mocks.sendEmail).not.toHaveBeenCalled()
	})

	it('reports ambiguous delivery and never retries the ownership CAS', async () => {
		mocks.sendEmail.mockRejectedValue(new Error('mail provider timeout'))
		expect(await initiateSupportPurchaseTransfer(input)).toEqual({
			state: 'delivery_unknown', transferId: 'transfer-1',
		})
		expect(mocks.directTransfer).not.toHaveBeenCalled()
	})
})
