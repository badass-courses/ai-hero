import { beforeEach, describe, expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({
	bulk: false,
	bulkRefund: vi.fn(async () => ({ success: true })),
	softDelete: vi.fn(async () => ({ rowsAffected: 1 })),
	markDispute: vi.fn(async () => {}),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/db', () => ({
	db: { query: { purchases: { findFirst: async () => null } } },
}))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		createFunction: (config: any, triggers: any, handler: any) => ({
			config,
			triggers,
			handler,
		}),
	},
}))
vi.mock('@/lib/bulk-purchase-refund', () => ({
	isBulkPurchase: () => f.bulk,
	refundBulkPurchaseEntitlements: f.bulkRefund,
}))
vi.mock('@/lib/entitlements', () => ({
	getCreditEntitlementsForSourcePurchase: async () => [],
	softDeleteCreditEntitlements: vi.fn(),
	softDeleteEntitlementsForPurchase: f.softDelete,
}))
vi.mock('@/lib/purchase-disputes', () => ({
	markPurchaseDisputeRefunded: f.markDispute,
}))
vi.mock('@/server/logger', () => ({ log: f.log }))
import { refundEntitlements } from './refund-entitlements'
const workflow = refundEntitlements as unknown as {
	handler: (input: any) => Promise<any>
	triggers: any[]
}
const valid = {
	id: 'early_in_test',
	userId: 'u',
	productId: 'product',
	status: 'Refunded',
	merchantChargeId: null,
	fields: { earlyAccess: true, invoiceId: 'in_test' },
}
function run(purchase = valid) {
	return workflow.handler({
		event: {
			name: 'aihero/early-access.revoke',
			data: { purchaseId: valid.id, invoiceId: 'in_test' },
		},
		step: { run: async (_name: string, fn: () => unknown) => fn() },
		db: {
			getPurchase: async () => purchase,
			getPurchaseForStripeCharge: vi.fn(),
		},
	})
}
beforeEach(() => {
	vi.clearAllMocks()
	f.bulk = false
})
describe('charge-free early-access refund cleanup', () => {
	it('registers the explicit revoke event alongside real refunds', () => {
		expect(workflow.triggers).toContainEqual({
			event: 'aihero/early-access.revoke',
		})
	})
	it('uses the existing individual entitlement cleanup', async () => {
		await run()
		expect(f.softDelete).toHaveBeenCalledWith(valid.id)
	})
	it('uses the existing bulk cleanup including redeemed seats and Discord', async () => {
		f.bulk = true
		await run()
		expect(f.bulkRefund).toHaveBeenCalledWith(valid)
	})
	it.each([
		{ ...valid, status: 'Valid' },
		{ ...valid, merchantChargeId: 'charge' },
		{ ...valid, fields: { earlyAccess: false, invoiceId: 'in_test' } },
		{ ...valid, fields: { earlyAccess: true, invoiceId: 'in_other' } },
	])('rejects identity/status mismatch', async (purchase) => {
		await expect(run(purchase as typeof valid)).rejects.toThrow(
			'identity/status mismatch',
		)
		expect(f.softDelete).not.toHaveBeenCalled()
		expect(f.bulkRefund).not.toHaveBeenCalled()
	})
})
