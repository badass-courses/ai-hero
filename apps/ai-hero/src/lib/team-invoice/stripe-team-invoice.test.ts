import { describe, expect, it, vi } from 'vitest'

import {
	createAndSendTeamInvoice,
	invoiceCustomFields,
	SELF_SERVE_CUSTOMER_SOURCE,
	TeamInvoiceTotalMismatch,
	type CreateTeamInvoiceInput,
	type TeamInvoiceStripe,
} from './stripe-team-invoice'

function fakeStripe(options: { total?: number; existing?: any[] } = {}) {
	const stripe = {
		customers: {
			list: vi.fn().mockResolvedValue({ data: options.existing ?? [] }),
			create: vi.fn().mockResolvedValue({ id: 'cus_new' }),
		},
		coupons: { create: vi.fn().mockResolvedValue({ id: 'coupon_once' }) },
		invoices: {
			create: vi.fn().mockResolvedValue({ id: 'in_1' }),
			finalizeInvoice: vi
				.fn()
				.mockResolvedValue({ id: 'in_1', total: options.total ?? 40_000 }),
			sendInvoice: vi.fn().mockResolvedValue({
				id: 'in_1',
				total: options.total ?? 40_000,
				status: 'open',
				hosted_invoice_url: 'https://invoice.stripe.test/in_1',
			}),
			voidInvoice: vi.fn().mockResolvedValue({ id: 'in_1', status: 'void' }),
		},
		invoiceItems: { create: vi.fn().mockResolvedValue({ id: 'ii_1' }) },
	}
	return stripe as typeof stripe & TeamInvoiceStripe
}

const input: CreateTeamInvoiceInput = {
	orderKey: 'team-invoice-abc',
	billingEmail: 'billing@example.test',
	companyName: 'Example Co',
	address: { line1: '1 Test St', country: 'DE' },
	taxId: 'DE123',
	poNumber: 'PO-1',
	due: { kind: 'days', days: 30 },
	stripePriceId: 'price_1',
	stripeProductId: 'prod_1',
	quantity: 5,
	discount: { kind: 'stripe-coupon', stripeCouponId: 'bulk_20' },
	expectedTotal: 40_000,
	metadata: { source: 'self_serve_team_invoice', seats: '5' },
}

describe('createAndSendTeamInvoice', () => {
	it('makes the generic invoice shape: one price line × quantity, discount, metadata', async () => {
		const stripe = fakeStripe()
		const result = await createAndSendTeamInvoice(stripe, input)

		expect(stripe.customers.create).toHaveBeenCalledWith(
			expect.objectContaining({
				email: 'billing@example.test',
				name: 'Example Co',
				address: expect.objectContaining({ line1: '1 Test St', country: 'DE' }),
				metadata: expect.objectContaining({ source: SELF_SERVE_CUSTOMER_SOURCE }),
			}),
			{ idempotencyKey: 'team-invoice-abc:customer' },
		)
		expect(stripe.invoices.create).toHaveBeenCalledWith(
			{
				customer: 'cus_new',
				collection_method: 'send_invoice',
				days_until_due: 30,
				auto_advance: false,
				pending_invoice_items_behavior: 'exclude',
				discounts: [{ coupon: 'bulk_20' }],
				custom_fields: [
					{ name: 'PO number', value: 'PO-1' },
					{ name: 'Tax ID', value: 'DE123' },
				],
				metadata: input.metadata,
			},
			{ idempotencyKey: 'team-invoice-abc:invoice' },
		)
		expect(stripe.invoiceItems.create).toHaveBeenCalledWith(
			{
				customer: 'cus_new',
				invoice: 'in_1',
				price: 'price_1',
				quantity: 5,
				metadata: input.metadata,
			},
			{ idempotencyKey: 'team-invoice-abc:item' },
		)
		expect(stripe.coupons.create).not.toHaveBeenCalled()
		expect(stripe.invoices.sendInvoice).toHaveBeenCalledTimes(1)
		expect(result).toEqual({
			invoiceId: 'in_1',
			customerId: 'cus_new',
			total: 40_000,
			hostedInvoiceUrl: 'https://invoice.stripe.test/in_1',
			status: 'open',
		})
	})

	const sameDetails = {
		name: 'Example Co',
		address: {
			line1: '1 Test St',
			line2: null,
			city: null,
			state: null,
			postal_code: null,
			country: 'DE',
		},
	}

	it('reuses a self-serve customer only when its details already match', async () => {
		const stripe = fakeStripe({
			existing: [
				{ id: 'cus_checkout', metadata: {}, ...sameDetails },
				{
					id: 'cus_team',
					metadata: { source: SELF_SERVE_CUSTOMER_SOURCE },
					...sameDetails,
				},
			],
		})
		await createAndSendTeamInvoice(stripe, input)
		expect(stripe.customers.create).not.toHaveBeenCalled()
		expect(stripe.invoices.create).toHaveBeenCalledWith(
			expect.objectContaining({ customer: 'cus_team' }),
			expect.anything(),
		)
	})

	it('never rewrites an existing customer: different details get a new one', async () => {
		const stripe = fakeStripe({
			existing: [
				{
					id: 'cus_team',
					metadata: { source: SELF_SERVE_CUSTOMER_SOURCE },
					...sameDetails,
					name: 'Real Buyer Inc',
				},
			],
		})
		await createAndSendTeamInvoice(stripe, input)
		expect(stripe.customers).not.toHaveProperty('update')
		expect(stripe.customers.create).toHaveBeenCalledTimes(1)
		expect(stripe.invoices.create).toHaveBeenCalledWith(
			expect.objectContaining({ customer: 'cus_new' }),
			expect.anything(),
		)
	})

	it('sets a fixed due date when one is given', async () => {
		const stripe = fakeStripe()
		await createAndSendTeamInvoice(stripe, {
			...input,
			due: { kind: 'date', at: 1_792_000_000 },
		})
		const params = stripe.invoices.create.mock.calls[0]![0]
		expect(params).toMatchObject({ due_date: 1_792_000_000 })
		expect(params).not.toHaveProperty('days_until_due')
	})

	it('makes one single-use, product-scoped coupon for an amount off', async () => {
		const stripe = fakeStripe()
		await createAndSendTeamInvoice(stripe, {
			...input,
			discount: { kind: 'amount-off', amountOff: 10_000 },
		})
		expect(stripe.coupons.create).toHaveBeenCalledWith(
			{
				amount_off: 10_000,
				currency: 'usd',
				duration: 'once',
				max_redemptions: 1,
				applies_to: { products: ['prod_1'] },
				name: 'Team pricing',
				metadata: input.metadata,
			},
			{ idempotencyKey: 'team-invoice-abc:coupon' },
		)
		expect(stripe.invoices.create).toHaveBeenCalledWith(
			expect.objectContaining({ discounts: [{ coupon: 'coupon_once' }] }),
			expect.anything(),
		)
	})

	it('voids instead of sending when the total is not the priced amount', async () => {
		const stripe = fakeStripe({ total: 50_000 })
		await expect(createAndSendTeamInvoice(stripe, input)).rejects.toBeInstanceOf(
			TeamInvoiceTotalMismatch,
		)
		expect(stripe.invoices.voidInvoice).toHaveBeenCalledWith(
			'in_1',
			undefined,
			{ idempotencyKey: 'team-invoice-abc:void' },
		)
		expect(stripe.invoices.sendInvoice).not.toHaveBeenCalled()
	})

	it('omits empty optional fields', async () => {
		const stripe = fakeStripe()
		await createAndSendTeamInvoice(stripe, {
			...input,
			address: undefined,
			taxId: undefined,
			poNumber: undefined,
			discount: { kind: 'none' },
		})
		const params = stripe.invoices.create.mock.calls[0]![0]
		expect(params).not.toHaveProperty('discounts')
		expect(params).not.toHaveProperty('custom_fields')
		expect(stripe.customers.create.mock.calls[0]![0]).not.toHaveProperty(
			'address',
		)
		expect(invoiceCustomFields({})).toEqual([])
	})
})
