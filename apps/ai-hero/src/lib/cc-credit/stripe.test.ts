import { describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { readCreditInvoice } from './stripe'

function reader(overrides: Record<string, unknown> = {}) {
	const invoices = {
		retrieve: vi.fn(async () => ({
			id: 'in_synthetic',
			customer: 'cus_synthetic',
			status: 'draft',
			currency: 'usd',
		})),
		listLineItems: vi
			.fn()
			.mockResolvedValueOnce({
				has_more: true,
				data: [
					{
						id: 'il_one',
						price: { product: 'prod_c5' },
						quantity: 2,
						amount: 100000,
						discount_amounts: [{ amount: 20000 }],
						currency: 'usd',
						description: 'Target seats',
					},
				],
			})
			.mockResolvedValueOnce({
				has_more: false,
				data: [
					{
						id: 'il_two',
						price: null,
						quantity: 1,
						amount: -20000,
						currency: 'usd',
						description: 'Crash Course team seat credit x 2',
					},
				],
			}),
		...overrides,
	}
	return {
		client: { invoices } as unknown as Pick<Stripe, 'invoices'>,
		invoices,
	}
}
describe('read-only credited invoice evidence', () => {
	it('reads late-page credit lines and the actual mapped target product quantity', async () => {
		const { client, invoices } = reader()
		expect(
			await readCreditInvoice(client, 'in_synthetic', new Set(['prod_c5'])),
		).toMatchObject({
			invoiceId: 'in_synthetic',
			c5Seats: 2,
			c5AmountCents: 80000,
			creditLines: [{ amountCents: -20000 }],
		})
		expect(invoices.listLineItems).toHaveBeenLastCalledWith('in_synthetic', {
			limit: 100,
			starting_after: 'il_one',
		})
	})
	it('holds incomplete pagination and does not invent credit from a missing page', async () => {
		const { client } = reader({
			listLineItems: vi.fn(async () => ({ has_more: true, data: [] })),
		})
		await expect(
			readCreditInvoice(client, 'in_synthetic', new Set(['prod_c5'])),
		).rejects.toMatchObject({ reason: 'invoice_pagination_incomplete' })
	})
})
