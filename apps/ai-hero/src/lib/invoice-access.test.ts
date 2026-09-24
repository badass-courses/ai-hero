import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getPurchasesForUser: vi.fn(),
	getPurchase: vi.fn(),
	findCharges: vi.fn(),
	findPurchases: vi.fn(),
}))

vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		getPurchasesForUser: mocks.getPurchasesForUser,
		getPurchase: mocks.getPurchase,
	},
	db: {
		query: {
			merchantCharge: { findMany: mocks.findCharges },
			purchases: { findMany: mocks.findPurchases },
		},
	},
}))
vi.mock('@/db/schema', () => ({
	merchantCharge: { id: 'charge.id', userId: 'charge.userId' },
	purchases: { createdAt: 'purchase.createdAt', merchantChargeId: 'purchase.merchantChargeId' },
}))
vi.mock('drizzle-orm', () => ({
	asc: (value: unknown) => value,
	eq: (...values: unknown[]) => values,
	inArray: (...values: unknown[]) => values,
}))

import { getInvoicePurchasesForUser } from './invoice-access'

const owned = { id: 'purchase-owned', status: 'Valid' }
const transferred = { id: 'purchase-transferred', status: 'Valid' }

describe('invoice purchase access', () => {
	beforeEach(() => {
		vi.resetAllMocks()
		mocks.getPurchasesForUser.mockResolvedValue([owned])
		mocks.findCharges.mockResolvedValue([{ id: 'charge-original-payer' }])
		mocks.findPurchases.mockResolvedValue([{ id: transferred.id }])
		mocks.getPurchase.mockResolvedValue(transferred)
	})

	it('keeps a transferred purchase in the original payer invoice list', async () => {
		await expect(getInvoicePurchasesForUser('payer-1')).resolves.toEqual([
			owned,
			transferred,
		])
	})

	it('does not duplicate a purchase still owned by the payer', async () => {
		mocks.findPurchases.mockResolvedValue([{ id: owned.id }])
		mocks.getPurchase.mockResolvedValue(owned)
		await expect(getInvoicePurchasesForUser('payer-1')).resolves.toEqual([owned])
	})
})
