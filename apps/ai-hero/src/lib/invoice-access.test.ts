import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	findCharges: vi.fn(),
	findPurchases: vi.fn(),
}))

vi.mock('@/db', () => ({
	db: {
		query: {
			merchantCharge: { findMany: mocks.findCharges },
			purchases: { findMany: mocks.findPurchases },
		},
	},
}))
vi.mock('@/db/schema', () => ({
	merchantCharge: { id: 'charge.id', userId: 'charge.userId' },
	purchases: {
		createdAt: 'purchase.createdAt',
		merchantChargeId: 'purchase.merchantChargeId',
		status: 'purchase.status',
	},
}))
vi.mock('drizzle-orm', () => ({
	and: (...values: unknown[]) => values,
	asc: (value: unknown) => value,
	eq: (...values: unknown[]) => values,
	inArray: (...values: unknown[]) => values,
}))

import { getInvoicePurchasesForUser } from './invoice-access'

const transferred = {
	id: 'purchase-transferred',
	createdAt: new Date('2026-09-24T00:00:00Z'),
	totalAmount: '199.00',
	productId: 'product-1',
	status: 'Valid',
	fields: {},
	product: {
		id: 'product-1',
		name: 'AI Coding Crash Course',
		fields: { slug: 'ai-coding-crash-course' },
		createdAt: null,
	},
}

describe('invoice purchase access', () => {
	beforeEach(() => {
		vi.resetAllMocks()
		mocks.findCharges.mockResolvedValue([{ id: 'charge-original-payer' }])
		mocks.findPurchases.mockResolvedValue([transferred])
	})

	it('keeps a transferred purchase with its product in the original payer invoice list', async () => {
		await expect(getInvoicePurchasesForUser('payer-1')).resolves.toEqual([
			expect.objectContaining({
				...transferred,
				totalAmount: 199,
				product: expect.objectContaining({
					id: 'product-1',
					name: 'AI Coding Crash Course',
				}),
			}),
		])
		expect(mocks.findPurchases).toHaveBeenCalledWith(
			expect.objectContaining({
				with: { product: true, user: true, bulkCoupon: true },
			}),
		)
	})

	it('does not expose a transferred invoice to the recipient', async () => {
		mocks.findCharges.mockResolvedValue([])
		await expect(getInvoicePurchasesForUser('learner-1')).resolves.toEqual([])
		expect(mocks.findPurchases).not.toHaveBeenCalled()
	})
})
