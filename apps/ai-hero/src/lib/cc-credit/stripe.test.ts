import { describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import {
	isCreditDescription,
	readCreditInvoice,
	readSourcePayments,
} from './stripe'

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
	it('recognizes every hand-written credit wording', () => {
		for (const text of [
			'Crash Course credit',
			'Crash Course team credit',
			'Crash Course team seat credit x 3',
			'crash course seat credit',
		])
			expect(isCreditDescription(text)).toBe(true)
		expect(isCreditDescription('Workshop credit')).toBe(false)
	})
	it('holds a C5 invoice with a negative line that is not a recognized credit', async () => {
		const { client } = reader({
			listLineItems: vi.fn(async () => ({
				has_more: false,
				data: [
					{
						id: 'il_one',
						price: { product: 'prod_c5' },
						quantity: 2,
						amount: 100000,
						currency: 'usd',
						description: 'Target seats',
					},
					{
						id: 'il_two',
						price: null,
						quantity: 1,
						amount: -19900,
						currency: 'usd',
						description: 'Prior purchase adjustment',
					},
				],
			})),
		})
		await expect(
			readCreditInvoice(client, 'in_synthetic', new Set(['prod_c5'])),
		).rejects.toMatchObject({
			reason: 'unrecognized_negative_line_hold_for_review',
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

describe('read-only source purchase payment evidence', () => {
	const charge = (overrides: Record<string, unknown> = {}) => ({
		id: 'ch_synthetic',
		status: 'succeeded',
		currency: 'usd',
		amount: 224250,
		amount_refunded: 0,
		...overrides,
	})
	function client(
		chargeValue: Record<string, unknown>,
		items: Record<string, unknown>[] = [{ quantity: 10, amount_total: 224250 }],
	) {
		const charges = { retrieve: vi.fn(async () => chargeValue) }
		const listLineItems = vi.fn(async () => ({ has_more: false, data: items }))
		return {
			stripe: {
				charges,
				checkout: { sessions: { listLineItems } },
			} as unknown as Pick<Stripe, 'charges' | 'checkout'>,
			listLineItems,
		}
	}
	const row = {
		purchaseId: 'purch_3f8e2c1a-9b7d-4e6f-a5c4-1d2e3f4a5b6c',
		chargeIdentifier: 'ch_synthetic',
		checkoutSessionIdentifier: 'cs_synthetic',
	}
	it('takes exact charge cents and this checkout quantity', async () => {
		const { stripe, listLineItems } = client(charge())
		expect(
			(await readSourcePayments(stripe, [row])).get(row.purchaseId),
		).toEqual({ chargeCents: 224250, seats: 10 })
		expect(listLineItems).toHaveBeenCalledWith('cs_synthetic', { limit: 100 })
	})
	it('reports no seat evidence when the purchase has no checkout session', async () => {
		const { stripe, listLineItems } = client(charge())
		expect(
			(
				await readSourcePayments(stripe, [
					{ ...row, checkoutSessionIdentifier: null },
				])
			).get(row.purchaseId),
		).toEqual({ chargeCents: 224250, seats: null })
		expect(listLineItems).not.toHaveBeenCalled()
	})
	it.each([
		[
			'source_charge_evidence_missing_hold_for_review',
			charge(),
			{ chargeIdentifier: null },
			undefined,
		],
		[
			'source_charge_refunded_hold_for_review',
			charge({ amount_refunded: 22425 }),
			{},
			undefined,
		],
		[
			'source_charge_not_settled_usd_hold_for_review',
			charge({ status: 'pending' }),
			{},
			undefined,
		],
		[
			'source_checkout_evidence_ambiguous_hold_for_review',
			charge(),
			{},
			[{ quantity: 10, amount_total: 224300 }],
		],
		[
			'source_checkout_evidence_ambiguous_hold_for_review',
			charge(),
			{},
			[
				{ quantity: 5, amount_total: 112125 },
				{ quantity: 5, amount_total: 112125 },
			],
		],
	] as const)('holds with %s', async (hold, chargeValue, changed, items) => {
		const { stripe } = client(
			chargeValue,
			items ? items.map((item) => ({ ...item })) : undefined,
		)
		expect(
			(await readSourcePayments(stripe, [{ ...row, ...changed }])).get(
				row.purchaseId,
			),
		).toEqual({ hold })
	})
})
