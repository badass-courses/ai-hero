import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
	transfer: vi.fn(),
	purchase: vi.fn(),
	user: vi.fn(),
	record: vi.fn(async (_args: unknown) => ({ counts: { written: 1 } })),
}))
vi.mock('@/db', () => ({
	db: {
		query: {
			purchaseUserTransfer: { findFirst: mocks.transfer },
			purchases: { findFirst: mocks.purchase },
			users: { findFirst: mocks.user },
		},
	},
}))
vi.mock('./subscriber-marketing/drizzle-capture-repository', () => ({
	DrizzleCaptureMarketingRepository: class {},
}))
vi.mock('./subscriber-marketing/buyer-entitlement', () => ({
	recordBuyerEntitlement: mocks.record,
}))
import {
	captureTransferBuyerEntitlement,
	captureTeamSeatBuyerEntitlement,
} from './capture-buyer-entitlement'
const at = '2026-11-02T12:00:00.000Z'
beforeEach(() => {
	vi.clearAllMocks()
	mocks.transfer.mockResolvedValue({
		id: 'transfer-1',
		purchaseId: 'purchase-1',
		targetUserId: 'receiver-1',
		transferState: 'COMPLETED',
		completedAt: new Date(at),
	})
	mocks.purchase.mockResolvedValue({
		id: 'purchase-1',
		productId: 'course-1',
		userId: 'receiver-1',
		redeemedBulkCouponId: 'team-1',
		createdAt: new Date(at),
	})
	mocks.user.mockResolvedValue({
		id: 'receiver-1',
		email: 'receiver@example.test',
		name: 'Receiver',
	})
})
describe('receiving buyer entitlement sources', () => {
	it('uses the completed transfer target and stable transfer grant key', async () => {
		await captureTransferBuyerEntitlement('transfer-1')
		expect(mocks.record).toHaveBeenCalledWith(
			expect.objectContaining({
				source: expect.objectContaining({
					userId: 'receiver-1',
					entitlementId: 'purchase-transfer:transfer-1',
					productId: 'course-1',
					change: 'granted',
					occurredAt: at,
				}),
			}),
		)
	})
	it.each(['VERIFIED', 'CANCELED', 'EXPIRED'])(
		'never grants from a %s transfer',
		async (transferState) => {
			mocks.transfer.mockResolvedValue({ transferState })
			await expect(
				captureTransferBuyerEntitlement('transfer-1'),
			).rejects.toThrow('completed transfer')
			expect(mocks.record).not.toHaveBeenCalled()
		},
	)
	it('uses the redeemed seat purchase owner and stable seat grant key', async () => {
		await captureTeamSeatBuyerEntitlement('purchase-1')
		expect(mocks.record).toHaveBeenCalledWith(
			expect.objectContaining({
				source: expect.objectContaining({
					userId: 'receiver-1',
					entitlementId: 'team-seat:purchase-1',
					productId: 'course-1',
					change: 'granted',
					occurredAt: at,
				}),
			}),
		)
	})
	it('refuses a purchase that is not a redeemed seat', async () => {
		mocks.purchase.mockResolvedValue({
			userId: 'receiver-1',
			redeemedBulkCouponId: null,
		})
		await expect(captureTeamSeatBuyerEntitlement('purchase-1')).rejects.toThrow(
			'redeemed team seat',
		)
		expect(mocks.record).not.toHaveBeenCalled()
	})
})
