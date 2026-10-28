import { describe, expect, it, vi } from 'vitest'
import { inventoryCredits } from './inventory'
import type { CreditReceipt } from './domain'

async function* items<T>(values: T[]) {
	yield* values
}
const receipt = (
	invoiceId: string,
	status: CreditReceipt['status'] = 'paid',
): CreditReceipt => ({
	invoiceId,
	stripeCustomerId: 'cus_synthetic',
	requestHash: 'hash',
	seats: 2,
	amountCents: 20000,
	currency: 'usd',
	status,
	allocations: [
		{
			purchaseId: 'purch_synthetic',
			seats: 2,
			perSeatCents: 10000,
			purchaseSeats: 3,
			purchaseTotalCents: 30000,
		},
	],
})
describe('read-only historical CC invoice inventory', () => {
	it('reports counts and holds double-use plans even though each invoice alone would fit', async () => {
		const preview = vi.fn(async (input: { invoiceId: string }) => ({
			ok: true,
			result: {
				receipt: receipt(
					input.invoiceId,
					input.invoiceId === 'void' ? 'released' : 'paid',
				),
				remainingByPurchase: { purch_synthetic: 3 },
			},
		}))
		const plan = await inventoryCredits(
			{
				invoices: items(
					['none', 'first', 'second', 'ambiguous', 'void'].map((id) => ({
						id,
						customer: 'cus_synthetic',
					})),
				),
				lines: (id) =>
					items(
						id === 'none'
							? [{ description: 'Other product', amount: 1 }]
							: [
									{
										description:
											id === 'ambiguous'
												? 'Crash Course credit'
												: 'Crash Course team seat credit x 2 (purch_synthetic)',
										amount: -20000,
									},
								],
					),
				preview,
			},
			'test-run',
		)
		expect(plan.counts).toEqual({
			scannedInvoices: 5,
			matchedInvoices: 4,
			previewed: 2,
			alreadyLedgered: 0,
			held: 2,
			reserved: 0,
			paid: 1,
			released: 1,
		})
		expect(
			plan.records
				.filter((row) => row.state === 'hold')
				.map((row) => row.reason),
		).toEqual([
			'historical_invoices_double_spend_same_purchase',
			'historical_credit_seat_count_or_amount_ambiguous',
		])
		expect(preview).toHaveBeenCalledTimes(3)
	})
	it('does not project already-ledgered receipts twice and treats source outages as holds', async () => {
		const plan = await inventoryCredits(
			{
				invoices: items(
					['existing', 'unavailable'].map((id) => ({
						id,
						customer: { id: 'cus_synthetic' },
					})),
				),
				lines: () =>
					items([
						{
							description: 'Crash Course credit x 2 (purch_synthetic)',
							amount: -20000,
						},
					]),
				preview: async (input) =>
					input.invoiceId === 'existing'
						? {
								ok: true,
								result: { receipt: receipt('existing'), idempotent: true },
							}
						: { ok: false, result: { reason: 'preview_unavailable' } },
			},
			'test-run',
		)
		expect(plan.counts).toMatchObject({
			matchedInvoices: 2,
			alreadyLedgered: 1,
			held: 1,
			previewed: 0,
		})
	})
})
