import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	findCharges: vi.fn(),
	findPurchases: vi.fn(),
	findTransfers: vi.fn(),
	findCustomers: vi.fn(),
}))

vi.mock('@/db', () => ({
	db: {
		query: {
			merchantCharge: { findMany: mocks.findCharges },
			purchases: { findMany: mocks.findPurchases },
			purchaseUserTransfer: { findMany: mocks.findTransfers },
			merchantCustomer: { findMany: mocks.findCustomers },
		},
	},
}))
vi.mock('@/db/schema', () => ({
	merchantCharge: {
		id: 'charge.id',
		userId: 'charge.userId',
		merchantCustomerId: 'charge.merchantCustomerId',
	},
	purchases: {
		createdAt: 'purchase.createdAt',
		merchantChargeId: 'purchase.merchantChargeId',
		status: 'purchase.status',
		userId: 'purchase.userId',
		id: 'purchase.id',
	},
	merchantCustomer: { id: 'customer.id', userId: 'customer.userId' },
	purchaseUserTransfer: {
		purchaseId: 'transfer.purchaseId',
		sourceUserId: 'transfer.sourceUserId',
		transferState: 'transfer.transferState',
	},
}))
vi.mock('drizzle-orm', () => ({
	and: (...values: unknown[]) => values,
	asc: (value: unknown) => value,
	eq: (...values: unknown[]) => values,
	inArray: (...values: unknown[]) => values,
	isNotNull: (value: unknown) => ['isNotNull', value],
	or: (...values: unknown[]) => ['or', ...values],
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
		mocks.findTransfers.mockResolvedValue([])
		mocks.findCustomers.mockResolvedValue([])
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

	it('lists a payer-of-record purchase by customer, view only', async () => {
		// The charge moved to the holder; the payer is still the customer.
		mocks.findCharges
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ id: 'charge-moved' }])
		mocks.findCustomers.mockResolvedValue([{ id: 'customer-1' }])
		const result = await getInvoicePurchasesForUser('payer-1')
		expect(result).toHaveLength(1)
		expect(result[0]?.canEdit).toBe(false)
	})

	it('lets the billing owner edit and a bare holder only view', async () => {
		mocks.findPurchases.mockResolvedValue([
			{ ...transferred, merchantChargeId: 'charge-original-payer' },
		])
		const owner = await getInvoicePurchasesForUser('payer-1')
		expect(owner[0]?.canEdit).toBe(true)
		mocks.findCharges.mockResolvedValue([])
		const holder = await getInvoicePurchasesForUser('learner-1')
		expect(holder[0]?.canEdit).toBe(false)
	})

	it('lists a purchase for its current holder', async () => {
		mocks.findCharges.mockResolvedValue([])
		await expect(getInvoicePurchasesForUser('learner-1')).resolves.toHaveLength(
			1,
		)
		expect(mocks.findPurchases).toHaveBeenCalledOnce()
	})

	it('lists a transferred purchase for the person who started the chain', async () => {
		// The charge moved to the holder, so only the transfer row names the payer.
		mocks.findCharges.mockResolvedValue([])
		mocks.findTransfers.mockImplementation(async (args: any) =>
			args.columns
				? [{ purchaseId: 'purchase-transferred' }]
				: [
						{
							transferState: 'COMPLETED',
							sourceUserId: 'payer-1',
							completedAt: new Date('2026-09-25T00:00:00Z'),
							createdAt: new Date('2026-09-24T00:00:00Z'),
						},
					],
		)
		await expect(getInvoicePurchasesForUser('payer-1')).resolves.toHaveLength(
			1,
		)
	})

	it('does not list a transferred purchase for an earlier non-paying holder', async () => {
		mocks.findCharges.mockResolvedValue([])
		mocks.findTransfers.mockImplementation(async (args: any) =>
			args.columns
				? [{ purchaseId: 'purchase-transferred' }]
				: [
						{
							transferState: 'COMPLETED',
							sourceUserId: 'payer-1',
							completedAt: new Date('2026-01-01T00:00:00Z'),
							createdAt: new Date('2026-01-01T00:00:00Z'),
						},
						{
							transferState: 'COMPLETED',
							sourceUserId: 'middle-holder',
							completedAt: new Date('2026-02-01T00:00:00Z'),
							createdAt: new Date('2026-02-01T00:00:00Z'),
						},
					],
		)
		const where = () =>
			JSON.stringify(mocks.findPurchases.mock.calls.at(-1)?.[0]?.where)
		await getInvoicePurchasesForUser('middle-holder')
		expect(where()).not.toContain('purchase-transferred')
	})
})
