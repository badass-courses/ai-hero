import { beforeEach, describe, expect, it, vi } from 'vitest'

const tables = vi.hoisted(() => ({
	merchantCharge: { name: 'merchantCharge', id: 'merchantCharge.id' },
	purchases: {
		name: 'purchases',
		id: 'purchases.id',
		userId: 'purchases.userId',
		productId: 'purchases.productId',
		status: 'purchases.status',
		merchantChargeId: 'purchases.merchantChargeId',
	},
	purchaseUserTransfer: {
		name: 'purchaseUserTransfer',
		id: 'transfer.id',
		purchaseId: 'transfer.purchaseId',
		sourceUserId: 'transfer.sourceUserId',
		targetUserId: 'transfer.targetUserId',
		transferState: 'transfer.transferState',
	},
}))

const mocks = vi.hoisted(() => ({
	getTransfer: vi.fn(),
	getPurchase: vi.fn(),
	getUserById: vi.fn(),
	getEntitlements: vi.fn(),
	findTransfers: vi.fn(),
	findPurchases: vi.fn(),
	findCharge: vi.fn(),
	transaction: vi.fn(),
	recordOutbox: vi.fn(),
	publishOutbox: vi.fn(),
	getUnpublished: vi.fn(),
	stripeRetrieve: vi.fn(),
	inngestSend: vi.fn(),
	updates: [] as Array<{ table: unknown; values: unknown }>,
}))

vi.mock('@/db/schema', () => tables)
vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		getPurchaseUserTransferById: mocks.getTransfer,
		getPurchase: mocks.getPurchase,
		getUserById: mocks.getUserById,
		getEntitlementsForUser: mocks.getEntitlements,
	},
	db: {
		query: {
			purchaseUserTransfer: { findMany: mocks.findTransfers },
			purchases: { findMany: mocks.findPurchases },
			merchantCharge: { findFirst: mocks.findCharge },
		},
		transaction: mocks.transaction,
	},
}))
vi.mock('@/env.mjs', () => ({
	env: { STRIPE_SECRET_TOKEN: 'test-stripe-secret' },
}))
vi.mock('@/purchase-transfer/transfer-outbox', () => ({
	recordTransferOutboxEvent: mocks.recordOutbox,
	publishTransferOutboxEvent: mocks.publishOutbox,
	getUnpublishedTransferOutboxEvents: mocks.getUnpublished,
}))
vi.mock('drizzle-orm', () => ({
	and: (...values: unknown[]) => values,
	eq: (...values: unknown[]) => values,
	inArray: (...values: unknown[]) => values,
	ne: (...values: unknown[]) => values,
}))
vi.mock('stripe', () => ({
	default: class Stripe {
		charges = { retrieve: mocks.stripeRetrieve }
	},
}))
vi.mock('inngest', () => ({
	Inngest: class Inngest {
		send = mocks.inngestSend
	},
}))
vi.mock('@coursebuilder/core/events/purchase-transfer', () => ({
	PURCHASE_TRANSFERRED_EVENT: 'commerce/purchase-transferred',
}))

import { completeSupportPurchaseTransfer } from './support-complete'

const input = {
	transferId: 'transfer-1',
	purchaseId: 'purchase-1',
	sourceUserId: 'buyer-1',
	targetEmail: 'learner@example.com',
}
const transfer = {
	id: 'transfer-1',
	purchaseId: 'purchase-1',
	sourceUserId: 'buyer-1',
	targetUserId: 'learner-1',
	transferState: 'INITIATED',
}
const purchase = {
	id: 'purchase-1',
	userId: 'buyer-1',
	productId: 'product-1',
	status: 'Valid',
	merchantChargeId: 'charge-1',
	bulkCouponId: null,
	redeemedBulkCouponId: null,
}

function tx() {
	return {
		update(table: unknown) {
			return {
				set(values: unknown) {
					mocks.updates.push({ table, values })
					return { where: vi.fn(async () => ({ rowsAffected: 1 })) }
				},
			}
		},
	}
}

describe('guarded support purchase completion', () => {
	beforeEach(() => {
		vi.resetAllMocks()
		mocks.updates.length = 0
		process.env.INNGEST_EVENT_KEY = 'test-event-key'
		mocks.getTransfer.mockResolvedValue(transfer)
		mocks.getPurchase.mockResolvedValue(purchase)
		mocks.getUserById.mockImplementation(async (id: string) =>
			id === 'buyer-1'
				? { id, email: 'buyer@example.com' }
				: { id, email: 'learner@example.com' },
		)
		mocks.getEntitlements.mockResolvedValue([])
		mocks.findTransfers.mockResolvedValue([])
		mocks.findPurchases.mockResolvedValue([])
		mocks.findCharge.mockResolvedValue({
			id: 'charge-1',
			identifier: 'ch_test',
			userId: 'buyer-1',
		})
		mocks.stripeRetrieve.mockResolvedValue({
			refunded: false,
			amount_refunded: 0,
			refunds: { data: [] },
		})
		mocks.transaction.mockImplementation(async (run: (value: ReturnType<typeof tx>) => unknown) => run(tx()))
		mocks.recordOutbox.mockResolvedValue('outbox-1')
		mocks.publishOutbox.mockResolvedValue({ published: true })
	})

	it('moves access ownership, preserves payer billing ownership, and dispatches the verified workflow', async () => {
		await expect(completeSupportPurchaseTransfer(input)).resolves.toEqual({
			state: 'completion_requested',
			transferId: 'transfer-1',
		})
		expect(mocks.updates).toEqual([
			{ table: tables.purchaseUserTransfer, values: expect.objectContaining({ transferState: 'VERIFIED' }) },
			{ table: tables.purchases, values: { userId: 'learner-1' } },
		])
		expect(mocks.updates.some((entry) => entry.table === tables.merchantCharge)).toBe(false)
		expect(mocks.findCharge).toHaveBeenCalledTimes(2)
		expect(mocks.recordOutbox).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				purchaseId: 'purchase-1',
				sourceUserId: 'buyer-1',
				targetUserId: 'learner-1',
			}),
		)
		expect(mocks.publishOutbox).toHaveBeenCalledWith(
			expect.objectContaining({ outboxId: 'outbox-1' }),
		)
	})

	it('same-person moves are refused before any write', async () => {
		mocks.getTransfer.mockResolvedValue({ ...transfer, targetUserId: 'buyer-1' })
		mocks.getUserById.mockImplementation(async (id: string) => ({
			id,
			email: 'learner@example.com',
		}))
		await expect(completeSupportPurchaseTransfer(input)).resolves.toEqual({
			state: 'blocked',
			reason: 'same_user_transfer',
		})
		expect(mocks.transaction).not.toHaveBeenCalled()
		expect(mocks.updates).toHaveLength(0)
	})

	it('never moves the purchase without claiming its own transfer row in the same transaction', async () => {
		await completeSupportPurchaseTransfer(input)
		const tables_ = mocks.updates.map((entry) => entry.table)
		expect(tables_).toEqual([tables.purchaseUserTransfer, tables.purchases])
		expect(mocks.transaction).toHaveBeenCalledTimes(1)
	})

	it('refuses a move that would change who the payer is', async () => {
		// An earlier completed transfer dated in the future: this move would
		// become the earliest and name a different payer.
		mocks.findTransfers.mockResolvedValueOnce([]).mockResolvedValueOnce([
			{
				id: 'transfer-0',
				transferState: 'COMPLETED',
				sourceUserId: 'original-payer',
				completedAt: new Date('2099-01-01T00:00:00.000Z'),
				createdAt: new Date('2099-01-01T00:00:00.000Z'),
			},
		])
		await expect(completeSupportPurchaseTransfer(input)).resolves.toEqual({
			state: 'blocked',
			reason: 'move_would_change_invoice_payer',
		})
		expect(mocks.transaction).not.toHaveBeenCalled()
	})

	it('fails closed for team purchases before any mutation', async () => {
		mocks.getPurchase.mockResolvedValue({ ...purchase, bulkCouponId: 'coupon-team' })
		await expect(completeSupportPurchaseTransfer(input)).resolves.toEqual({
			state: 'blocked',
			reason: 'team_purchase_not_supported',
		})
		expect(mocks.transaction).not.toHaveBeenCalled()
	})

	it('fails closed when Stripe shows any refund', async () => {
		mocks.stripeRetrieve.mockResolvedValue({
			refunded: false,
			amount_refunded: 100,
			refunds: { data: [{ status: 'succeeded' }] },
		})
		await expect(completeSupportPurchaseTransfer(input)).resolves.toEqual({
			state: 'blocked',
			reason: 'refund_present',
		})
		expect(mocks.transaction).not.toHaveBeenCalled()
	})
})
