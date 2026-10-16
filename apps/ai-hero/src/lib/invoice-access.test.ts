import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	findCharges: vi.fn(),
	findPurchases: vi.fn(),
	findTransfers: vi.fn(),
	customerQuery: vi.fn(),
}))

vi.mock('@/db', () => ({
	db: {
		query: {
			merchantCharge: { findMany: mocks.findCharges },
			purchases: { findMany: mocks.findPurchases },
			purchaseUserTransfer: { findMany: mocks.findTransfers },
			// Never expected: invoices must not follow the shared Stripe customer.
			merchantCustomer: {
				findMany: mocks.customerQuery,
				findFirst: mocks.customerQuery,
			},
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
		redeemedBulkCouponId: 'purchase.redeemedBulkCouponId',
	},
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
	isNull: (value: unknown) => ['isNull', value],
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

	it('excludes redeemed seats and does not follow a shared customer', async () => {
		// Buyer A paid for X and Y on one Stripe customer; X moved to B along
		// with the customer row. B's list may only reach charges B owns.
		mocks.findCharges.mockResolvedValue([{ id: 'charge-x' }])
		await getInvoicePurchasesForUser('holder-b')
		const where = JSON.stringify(mocks.findPurchases.mock.calls.at(-1)?.[0]?.where)
		expect(where).toContain('charge-x')
		expect(where).not.toContain('charge-y')
		expect(where).toContain('purchase.redeemedBulkCouponId')
		expect(mocks.customerQuery).not.toHaveBeenCalled()
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

	// Candidate query (with columns) then the batched COMPLETED rows.
	const chain = (rows: { sourceUserId: string; month: number }[]) =>
		mocks.findTransfers.mockImplementation(async (args: any) =>
			args.columns
				? [{ purchaseId: 'purchase-transferred' }]
				: rows.map((row, index) => ({
						id: `transfer-${index}`,
						purchaseId: 'purchase-transferred',
						transferState: 'COMPLETED',
						sourceUserId: row.sourceUserId,
						completedAt: new Date(Date.UTC(2026, row.month, 1)),
						createdAt: new Date(Date.UTC(2026, row.month, 1)),
					})),
		)
	const lastWhere = () =>
		JSON.stringify(mocks.findPurchases.mock.calls.at(-1)?.[0]?.where)

	it.each([
		['oldest first', [{ sourceUserId: 'payer-1', month: 1 }, { sourceUserId: 'middle-holder', month: 2 }]],
		['newest first', [{ sourceUserId: 'middle-holder', month: 2 }, { sourceUserId: 'payer-1', month: 1 }]],
	])(
		'lists a transferred purchase for the person who started the chain (%s)',
		async (_name, rows) => {
			// The charge moved to the holder, so only the transfer row names the payer.
			mocks.findCharges.mockResolvedValue([])
			chain(rows)
			await getInvoicePurchasesForUser('payer-1')
			expect(lastWhere()).toContain('purchase-transferred')
		},
	)

	it.each([
		['oldest first', [{ sourceUserId: 'payer-1', month: 1 }, { sourceUserId: 'middle-holder', month: 2 }]],
		['newest first', [{ sourceUserId: 'middle-holder', month: 2 }, { sourceUserId: 'payer-1', month: 1 }]],
	])(
		'does not list a transferred purchase for an earlier non-paying holder (%s)',
		async (_name, rows) => {
			mocks.findCharges.mockResolvedValue([])
			chain(rows)
			await getInvoicePurchasesForUser('middle-holder')
			expect(lastWhere()).not.toContain('purchase-transferred')
		},
	)
})
