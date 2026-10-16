import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	findCharges: vi.fn(),
	findPurchases: vi.fn(),
	findTransfers: vi.fn(),
	customerQuery: vi.fn(),
	samePersonRows: vi.fn(),
}))

vi.mock('@/db', () => ({
	db: {
		select: () => ({ from: () => ({ where: mocks.samePersonRows }) }),
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
	purchaseTransferSamePerson: {
		transferId: 'samePerson.transferId',
		verifiedBy: 'samePerson.verifiedBy',
		reason: 'samePerson.reason',
		proofRef: 'samePerson.proofRef',
	},
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
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('drizzle-orm', () => ({
	and: (...values: unknown[]) => values,
	asc: (value: unknown) => value,
	eq: (...values: unknown[]) => values,
	inArray: (...values: unknown[]) => values,
	isNotNull: (value: unknown) => ['isNotNull', value],
	isNull: (value: unknown) => ['isNull', value],
	or: (...values: unknown[]) => ['or', ...values],
	sql: (...values: unknown[]) => values,
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
		mocks.findCharges.mockResolvedValue([
			{ id: 'charge-original-payer', userId: 'payer-1' },
		])
		mocks.findPurchases.mockResolvedValue([transferred])
		mocks.findTransfers.mockResolvedValue([])
		mocks.samePersonRows.mockResolvedValue([])
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

	it.each([
		['pre-fix', 'holder-b'],
		['post-fix', 'payer-a'],
	])('%s transfer: only the payer edits in the list', async (shape, chargeUserId) => {
		// Pre-fix the charge was rewritten to the holder; post-fix it stays.
		const completed = [
			{
				id: 't1',
				purchaseId: 'purchase-transferred',
				transferState: 'COMPLETED',
				sourceUserId: 'payer-a',
				completedAt: new Date('2026-09-25T00:00:00Z'),
				createdAt: new Date('2026-09-24T00:00:00Z'),
			},
		]
		mocks.findTransfers.mockResolvedValue(completed)
		mocks.findPurchases.mockResolvedValue([
			{
				...transferred,
				userId: 'holder-b',
				merchantChargeId: 'charge-x',
			},
		])
		mocks.findCharges.mockResolvedValue([
			{ id: 'charge-x', userId: chargeUserId },
		])
		const payer = await getInvoicePurchasesForUser('payer-a')
		const holder = await getInvoicePurchasesForUser('holder-b')
		expect(payer[0]?.canEdit, shape).toBe(true)
		expect(holder[0]?.canEdit, shape).toBe(false)
	})

	describe('same-person move (A to A-prime)', () => {
		const sameTransfer = [
			{
				id: 't1',
				purchaseId: 'purchase-transferred',
				transferState: 'COMPLETED',
				sourceUserId: 'acct-a',
				targetUserId: 'acct-a2',
				completedAt: new Date('2026-09-25T00:00:00Z'),
				createdAt: new Date('2026-09-24T00:00:00Z'),
			},
		]
		// The reader query returns the id, the kind and a SQL verdict.
		const evidence = {
			transferId: 't1',
			verifiedBy: 'owner-mailbox-both',
			evidenceOk: 1,
		}
		const arrange = () => {
			mocks.findTransfers.mockResolvedValue(sameTransfer)
			mocks.findPurchases.mockResolvedValue([
				{
					...transferred,
					userId: 'acct-a2',
					merchantChargeId: 'charge-1',
				},
			])
			mocks.findCharges.mockResolvedValue([{ id: 'charge-1', userId: 'acct-a' }])
		}

		it('the new account edits and the old account views only', async () => {
			arrange()
			mocks.samePersonRows.mockResolvedValue([evidence])
			expect((await getInvoicePurchasesForUser('acct-a2'))[0]?.canEdit).toBe(true)
			expect((await getInvoicePurchasesForUser('acct-a'))[0]?.canEdit).toBe(false)
		})

		it('without recorded evidence the old account stays the payer', async () => {
			arrange()
			mocks.samePersonRows.mockResolvedValue([])
			expect((await getInvoicePurchasesForUser('acct-a2'))[0]?.canEdit).toBe(false)
			expect((await getInvoicePurchasesForUser('acct-a'))[0]?.canEdit).toBe(true)
		})

		it('a deploy before the migration gives the #439 answer instead of failing', async () => {
			arrange()
			mocks.samePersonRows.mockRejectedValue(
				Object.assign(new Error('Failed query'), {
					cause: Object.assign(new Error("Table 'x' doesn't exist"), {
						code: 'ER_NO_SUCH_TABLE',
					}),
				}),
			)
			expect((await getInvoicePurchasesForUser('acct-a'))[0]?.canEdit).toBe(true)
			expect((await getInvoicePurchasesForUser('acct-a2'))[0]?.canEdit).toBe(false)
		})

		it('a row whose reason or proof fails the SQL check is no flag', async () => {
			arrange()
			mocks.samePersonRows.mockResolvedValue([{ ...evidence, evidenceOk: 0 }])
			expect((await getInvoicePurchasesForUser('acct-a'))[0]?.canEdit).toBe(true)
		})
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
