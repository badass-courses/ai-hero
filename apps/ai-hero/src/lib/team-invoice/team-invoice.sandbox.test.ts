import { randomUUID } from 'node:crypto'
import Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'

import { commerceFunctions } from '@coursebuilder/commerce/functions'
import { StripePaymentAdapter } from '@coursebuilder/commerce/stripe-provider'

import { SELF_SERVE_TEAM_INVOICE_SOURCE } from './create-team-invoice'
import { createAndSendTeamInvoice } from './stripe-team-invoice'

/**
 * Stripe sandbox proof for the self-serve team invoice. Skipped unless
 * `AIH_STRIPE_SANDBOX_KEY` holds a test key (`sk_test_` or `rk_test_`); it
 * refuses anything else. Run it against the `aihero-commerce-tests` sandbox:
 *
 *   AIH_STRIPE_SANDBOX_KEY=sk_test_... \
 *   AIH_SANDBOX_STRIPE_PRODUCT=prod_... \
 *     pnpm vitest run src/lib/team-invoice/team-invoice.sandbox.test.ts
 *
 * It creates real sandbox objects through the app's own invoice code, pays the
 * invoice with a test card, reads the `invoice.payment_succeeded` event Stripe
 * emitted, and runs Course Builder's real fulfillment handler on it: the real
 * Stripe payments adapter (which refetches the invoice) and a recording
 * database adapter. Every object carries `rig=aihero-commerce` and a
 * `rig_run`, so a rig reset can archive them. No live keys, no database.
 */

const KEY = process.env.AIH_STRIPE_SANDBOX_KEY ?? ''
const PRODUCT = process.env.AIH_SANDBOX_STRIPE_PRODUCT ?? ''
const isTestKey = /^(sk|rk)_test_/.test(KEY)
const RUN = `team-invoice-${randomUUID()}`
const RIG = { rig: 'aihero-commerce', rig_run: RUN }
const APP_PRODUCT_ID = 'product-sandbox-team'

// The app's adapter pins this version (`STRIPE_VERSION` in commerce).
const stripe = isTestKey
	? new Stripe(KEY, { apiVersion: '2024-06-20' as Stripe.LatestApiVersion })
	: (null as unknown as Stripe)

const handler = commerceFunctions.find(
	(fn) => fn.config.id === 'stripe-invoice-payment-succeeded',
)!.handler as (input: any) => Promise<any>

async function listPrice() {
	const prices = await stripe.prices.list({
		product: PRODUCT,
		active: true,
		type: 'one_time',
		currency: 'usd',
		limit: 1,
	})
	const price = prices.data[0]
	if (!price?.unit_amount) throw new Error(`No one-time USD price on ${PRODUCT}`)
	return { id: price.id, unitAmount: price.unit_amount }
}

async function payWithTestCard(invoiceId: string, customerId: string) {
	const method = await stripe.paymentMethods.attach('pm_card_visa', {
		customer: customerId,
	})
	return stripe.invoices.pay(invoiceId, { payment_method: method.id })
}

async function paymentSucceededEvent(invoiceId: string) {
	for (let attempt = 0; attempt < 20; attempt++) {
		const events = await stripe.events.list({
			type: 'invoice.payment_succeeded',
			limit: 20,
		})
		const event = events.data.find(
			(candidate) => (candidate.data.object as Stripe.Invoice).id === invoiceId,
		)
		if (event) return event
		await new Promise((resolve) => setTimeout(resolve, 1_500))
	}
	throw new Error(`No invoice.payment_succeeded event for ${invoiceId}`)
}

/** Course Builder's adapter, recording what fulfillment asks it to write. */
function recordingAdapter(stripeProductId: string) {
	return {
		getMerchantAccount: vi.fn(async () => ({ id: 'merchant-account' })),
		findOrCreateUser: vi.fn(async (email: string) => ({
			user: { id: 'user-sandbox', email, role: 'user' },
			isNewUser: true,
		})),
		getUserByEmail: vi.fn(async () => null),
		getPurchaseForStripeCharge: vi.fn(async () => null),
		getPurchasesForUser: vi.fn(async () => []),
		getMerchantProduct: vi.fn(async (id: string) =>
			id === stripeProductId
				? { id: 'merchant-product', productId: APP_PRODUCT_ID }
				: null,
		),
		findOrCreateMerchantCustomer: vi.fn(async () => ({
			id: 'merchant-customer',
		})),
		getProduct: vi.fn(async () => ({
			id: APP_PRODUCT_ID,
			name: 'Sandbox Team Product',
			type: 'self-paced',
		})),
		createMerchantChargeAndPurchase: vi.fn(async (_input: Record<string, unknown>) => ({
			id: 'purchase-sandbox',
			bulkCouponId: 'bulk-coupon-sandbox',
			fields: {},
		})),
	}
}

async function fulfill(event: Stripe.Event, stripeProductId: string) {
	const db = recordingAdapter(stripeProductId)
	const sendEvent = vi.fn()
	await handler({
		event: {
			name: 'stripe/invoice-payment-succeeded',
			data: { stripeEvent: event, txnId: RUN },
		},
		step: {
			run: async (_name: string, fn: () => unknown) => fn(),
			sendEvent,
		},
		db,
		// The real adapter on the sandbox key: the handler refetches the invoice
		// from Stripe before deciding anything, as it does in production.
		paymentProvider: {
			options: {
				paymentsAdapter: new StripePaymentAdapter({
					stripeToken: KEY,
					stripeWebhookSecret: 'whsec_unused_in_this_test',
				}),
			},
		},
		notificationProvider: undefined,
	})
	return { db, sendEvent }
}

describe.skipIf(!isTestKey || !PRODUCT)('team invoice in the Stripe sandbox', () => {
	const metadata = (seats: number, policy: string) => ({
		...RIG,
		source: SELF_SERVE_TEAM_INVOICE_SOURCE,
		medium: 'team_invoice',
		campaign: 'team_sale',
		app: 'ai-hero',
		productId: APP_PRODUCT_ID,
		seats: String(seats),
		poNumber: 'PO-SANDBOX-1',
		policy,
	})

	it(
		'bills the bulk coupon, is idempotent, and pays into the existing fulfillment',
		async () => {
			const price = await listPrice()
			const seats = 5
			// Stands in for the bulk merchant coupon checkout applies.
			const bulk = await stripe.coupons.create({
				percent_off: 20,
				duration: 'once',
				name: 'Sandbox bulk 20%',
				metadata: RIG,
			})
			const expectedTotal = Math.round(price.unitAmount * seats * 0.8)
			const input = {
				orderKey: `${RUN}-bulk`,
				billingEmail: `team-${RUN}@example.test`,
				companyName: 'Sandbox Co',
				address: { line1: '1 Sandbox Way', city: 'Berlin', country: 'DE' },
				taxId: 'DE000000000',
				poNumber: 'PO-SANDBOX-1',
				due: { kind: 'days' as const, days: 30 },
				stripePriceId: price.id,
				stripeProductId: PRODUCT,
				quantity: seats,
				discount: { kind: 'stripe-coupon' as const, stripeCouponId: bulk.id },
				expectedTotal,
				metadata: metadata(seats, 'app-bulk:20'),
			}

			const first = await createAndSendTeamInvoice(stripe, input)
			const second = await createAndSendTeamInvoice(stripe, input)
			expect(second.invoiceId).toBe(first.invoiceId)
			expect(first.total).toBe(expectedTotal)
			expect(first.status).toBe('open')
			expect(first.hostedInvoiceUrl).toMatch(/^https:\/\//)

			const invoice = await stripe.invoices.retrieve(first.invoiceId, {
				expand: ['lines.data.price'],
			})
			expect(invoice.collection_method).toBe('send_invoice')
			expect(invoice.lines.data).toHaveLength(1)
			expect(invoice.lines.data[0]!.quantity).toBe(seats)
			expect(invoice.lines.data[0]!.price?.id).toBe(price.id)
			expect(invoice.metadata).toMatchObject(input.metadata)
			expect(invoice.custom_fields).toEqual([
				{ name: 'PO number', value: 'PO-SANDBOX-1' },
				{ name: 'Tax ID', value: 'DE000000000' },
			])

			const paid = await payWithTestCard(first.invoiceId, first.customerId)
			expect(paid.status).toBe('paid')
			expect(paid.amount_paid).toBe(expectedTotal)

			const event = await paymentSucceededEvent(first.invoiceId)
			const { db, sendEvent } = await fulfill(event, PRODUCT)

			expect(db.findOrCreateUser).toHaveBeenCalledWith(input.billingEmail)
			expect(db.createMerchantChargeAndPurchase).toHaveBeenCalledTimes(1)
			expect(db.createMerchantChargeAndPurchase.mock.calls[0]![0]).toMatchObject({
				productId: APP_PRODUCT_ID,
				quantity: seats,
				bulk: true,
				stripeChargeAmount: expectedTotal,
				stripeCouponId: bulk.id,
				checkoutSessionId: first.invoiceId,
				stripeChargeId: expect.stringMatching(/^ch_|^py_/),
			})
			expect(sendEvent).toHaveBeenCalledWith(
				'commerce/new-purchase-created',
				expect.objectContaining({
					data: expect.objectContaining({
						invoiceId: first.invoiceId,
						quantity: seats,
						customerEmail: input.billingEmail,
					}),
				}),
			)
			console.info(
				JSON.stringify({
					proof: 'bulk-coupon',
					run: RUN,
					invoice: first.invoiceId,
					event: event.id,
					eventApiVersion: event.api_version,
					total: paid.amount_paid,
					seats,
					fulfillment: db.createMerchantChargeAndPurchase.mock.calls[0]![0],
				}),
			)
		},
		90_000,
	)

	it(
		'bills a front-desk amount off with a one-time coupon, due on receipt',
		async () => {
			const price = await listPrice()
			const seats = 3
			const listTotal = price.unitAmount * seats
			// Any total below list stands in for a front-desk `priced` answer.
			const amountOff = Math.round(listTotal * 0.1)
			const result = await createAndSendTeamInvoice(stripe, {
				orderKey: `${RUN}-amount-off`,
				billingEmail: `team-${RUN}@example.test`,
				companyName: 'Sandbox Co',
				due: { kind: 'days', days: 0 },
				stripePriceId: price.id,
				stripeProductId: PRODUCT,
				quantity: seats,
				discount: { kind: 'amount-off', amountOff },
				expectedTotal: listTotal - amountOff,
				metadata: metadata(seats, 'sandbox-front-desk-fixture'),
			})
			expect(result.total).toBe(listTotal - amountOff)

			const invoice = await stripe.invoices.retrieve(result.invoiceId, {
				expand: ['discounts'],
			})
			const discount = invoice.discounts?.[0] as Stripe.Discount | undefined
			expect(discount?.coupon.amount_off).toBe(amountOff)
			expect(discount?.coupon.max_redemptions).toBe(1)
			expect(discount?.coupon.metadata).toMatchObject(RIG)

			const paid = await payWithTestCard(result.invoiceId, result.customerId)
			const event = await paymentSucceededEvent(result.invoiceId)
			const { db } = await fulfill(event, PRODUCT)
			expect(db.createMerchantChargeAndPurchase.mock.calls[0]![0]).toMatchObject({
				quantity: seats,
				bulk: true,
				stripeChargeAmount: paid.amount_paid,
			})
			console.info(
				JSON.stringify({
					proof: 'amount-off',
					run: RUN,
					invoice: result.invoiceId,
					event: event.id,
					total: paid.amount_paid,
					seats,
				}),
			)
		},
		90_000,
	)

	it(
		'takes a fixed due date and never rewrites an earlier customer',
		async () => {
			const price = await listPrice()
			const email = `team-${RUN}-due@example.test`
			const dueAt = Math.floor(Date.now() / 1000) + 10 * 24 * 60 * 60
			const base = {
				billingEmail: email,
				stripePriceId: price.id,
				stripeProductId: PRODUCT,
				quantity: 2,
				discount: { kind: 'none' as const },
				expectedTotal: price.unitAmount * 2,
				metadata: metadata(2, 'sandbox-due-date'),
			}
			const first = await createAndSendTeamInvoice(stripe, {
				...base,
				orderKey: `${RUN}-due-1`,
				companyName: 'First Buyer Co',
				due: { kind: 'date', at: dueAt },
			})
			const invoice = await stripe.invoices.retrieve(first.invoiceId)
			expect(invoice.due_date).toBe(dueAt)

			const second = await createAndSendTeamInvoice(stripe, {
				...base,
				orderKey: `${RUN}-due-2`,
				companyName: 'Someone Else Ltd',
				due: { kind: 'days', days: 30 },
			})
			expect(second.customerId).not.toBe(first.customerId)
			const firstCustomer = (await stripe.customers.retrieve(
				first.customerId,
			)) as Stripe.Customer
			expect(firstCustomer.name).toBe('First Buyer Co')

			// Same details again reuse the matching customer.
			const third = await createAndSendTeamInvoice(stripe, {
				...base,
				orderKey: `${RUN}-due-3`,
				companyName: 'First Buyer Co',
				due: { kind: 'days', days: 30 },
			})
			expect(third.customerId).toBe(first.customerId)
			for (const id of [first.invoiceId, second.invoiceId, third.invoiceId]) {
				await stripe.invoices.voidInvoice(id)
			}
			console.info(
				JSON.stringify({
					proof: 'due-date-and-customer',
					run: RUN,
					invoice: first.invoiceId,
					dueDate: invoice.due_date,
					firstCustomerNameAfter: firstCustomer.name,
					secondCustomerIsNew: second.customerId !== first.customerId,
					thirdReusedFirst: third.customerId === first.customerId,
				}),
			)
		},
		90_000,
	)

	it(
		'voids rather than sends an invoice whose total is not the priced amount',
		async () => {
			const price = await listPrice()
			await expect(
				createAndSendTeamInvoice(stripe, {
					orderKey: `${RUN}-mismatch`,
					billingEmail: `team-${RUN}@example.test`,
					companyName: 'Sandbox Co',
					due: { kind: 'days' as const, days: 30 },
					stripePriceId: price.id,
					stripeProductId: PRODUCT,
					quantity: 2,
					discount: { kind: 'none' },
					expectedTotal: price.unitAmount * 2 - 1,
					metadata: metadata(2, 'sandbox-mismatch'),
				}),
			).rejects.toThrow(/voided/)
			const voided = await stripe.invoices.search({
				query: `metadata['policy']:'sandbox-mismatch' AND metadata['rig_run']:'${RUN}'`,
			})
			// Search is eventually consistent; when it has the invoice, it is void.
			for (const invoice of voided.data) expect(invoice.status).toBe('void')
		},
		60_000,
	)
})
