import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	confirmTeamInvoice,
	SELF_SERVE_TEAM_INVOICE_SOURCE,
	startTeamInvoice,
	teamInvoiceDue,
	teamInvoiceOrderKey,
	type PendingTeamInvoice,
	type TeamInvoiceDeps,
	type TeamInvoiceProduct,
} from './create-team-invoice'
import {
	teamInvoiceSchema,
	type TeamInvoiceFormInput,
	type TeamInvoiceResult,
} from './schema'
import { TeamInvoiceTotalMismatch } from './stripe-team-invoice'
import type { TeamPrice } from './team-price-source'

const NOW = new Date('2026-10-10T12:00:00.000Z')
const OPENED = new Date(NOW.getTime() - 60_000).toISOString()

const onSaleProduct: TeamInvoiceProduct = {
	product: {
		id: 'product-test',
		name: 'Test Course',
		type: 'self-paced',
		status: 1,
		quantityAvailable: -1,
		fields: { state: 'published', visibility: 'public', slug: 'test-course' },
	},
	purchaseCount: 0,
	heldSeats: 0,
	stripePriceId: 'price_test',
	stripeProductId: 'prod_test',
	listUnitAmount: 10_000,
}

const priced: TeamPrice = {
	kind: 'priced',
	source: 'app-bulk',
	unitAmount: 8_000,
	amount: 40_000,
	policy: 'app-bulk:20',
	discount: { kind: 'stripe-coupon', stripeCouponId: 'stripe_bulk' },
}

const form = (
	overrides: Partial<TeamInvoiceFormInput> = {},
): TeamInvoiceFormInput => ({
	productId: 'product-test',
	companyName: 'Example Co',
	billingEmail: 'Billing@Example.test',
	seats: 5,
	terms: 'net_30',
	poNumber: 'PO-1',
	taxId: 'DE123',
	address: { line1: '1 Test St', country: 'de' },
	website: '',
	timestamp: OPENED,
	...overrides,
})

function makeDeps(overrides: Partial<TeamInvoiceDeps> = {}) {
	const store = new Map<string, TeamInvoiceResult>()
	const locks = new Set<string>()
	const pending = new Map<string, PendingTeamInvoice>()
	let tokens = 0
	const deps: TeamInvoiceDeps = {
		now: () => NOW,
		rateLimit: vi.fn().mockResolvedValue(true),
		dailyCeiling: vi.fn().mockResolvedValue(true),
		pending: {
			// Round-trips through JSON, as Redis does.
			put: vi.fn(async (token, order) => {
				pending.set(token, JSON.parse(JSON.stringify(order)))
			}),
			get: vi.fn(async (token) => pending.get(token) ?? null),
		},
		newToken: vi.fn(() => `token-${++tokens}-${'x'.repeat(32)}`),
		sendConfirmation: vi.fn().mockResolvedValue(undefined),
		idempotency: {
			get: vi.fn(async (key) => store.get(key) ?? null),
			lock: vi.fn(async (key) => {
				if (locks.has(key)) return false
				locks.add(key)
				return true
			}),
			unlock: vi.fn(async (key) => {
				locks.delete(key)
			}),
			set: vi.fn(async (key, result) => {
				store.set(key, result)
			}),
		},
		loadProduct: vi.fn().mockResolvedValue(onSaleProduct),
		buyer: vi.fn().mockResolvedValue({ existingSeats: 0, userId: 'user-1' }),
		priceSource: vi.fn(() => ({ price: vi.fn().mockResolvedValue(priced) })),
		invoicingEnabled: vi.fn().mockReturnValue(true),
		createInvoice: vi.fn().mockResolvedValue({
			invoiceId: 'in_test',
			customerId: 'cus_test',
			total: 40_000,
			hostedInvoiceUrl: 'https://invoice.stripe.test/in_test',
			status: 'open',
		}),
		forwardRequest: vi.fn().mockResolvedValue(undefined),
		log: vi.fn(),
		...overrides,
	}
	return deps
}

const ctx = { ip: '203.0.113.1' }

/** Start the order, then confirm it with the token the email carried. */
async function createTeamInvoice(
	input: TeamInvoiceFormInput,
	context: typeof ctx,
	deps: TeamInvoiceDeps,
): Promise<TeamInvoiceResult> {
	const started = await startTeamInvoice(input, context, deps)
	if (started.kind !== 'confirm-sent') return started
	const calls = vi.mocked(deps.sendConfirmation).mock.calls
	if (!calls.length) return started
	return confirmTeamInvoice(calls[calls.length - 1]![0].token, deps)
}

const request = (overrides: Partial<TeamInvoiceFormInput> = {}) =>
	teamInvoiceSchema.parse(form(overrides))

describe('createTeamInvoice', () => {
	let deps: ReturnType<typeof makeDeps>
	beforeEach(() => {
		deps = makeDeps()
	})

	it('invoices one product line at the server price with fulfillment metadata', async () => {
		const result = await createTeamInvoice(form(), ctx, deps)

		expect(result).toEqual({ kind: 'sent', email: 'billing@example.test' })
		expect(deps.createInvoice).toHaveBeenCalledTimes(1)
		const input = vi.mocked(deps.createInvoice).mock.calls[0]![0]
		expect(input).toMatchObject({
			billingEmail: 'billing@example.test',
			companyName: 'Example Co',
			stripePriceId: 'price_test',
			stripeProductId: 'prod_test',
			quantity: 5,
			due: { kind: 'days', days: 30 },
			discount: { kind: 'stripe-coupon', stripeCouponId: 'stripe_bulk' },
			expectedTotal: 40_000,
			taxId: 'DE123',
			poNumber: 'PO-1',
			address: { line1: '1 Test St', country: 'DE' },
		})
		expect(input.metadata).toMatchObject({
			source: SELF_SERVE_TEAM_INVOICE_SOURCE,
			productId: 'product-test',
			productSlug: 'test-course',
			seats: '5',
			poNumber: 'PO-1',
			policy: 'app-bulk:20',
			priceSource: 'app-bulk',
			medium: 'team_invoice',
			campaign: 'team_sale',
		})
		expect(input.orderKey).toBe(teamInvoiceOrderKey(request(), NOW))
	})

	it('passes existing seats and the list price to the price source', async () => {
		const price = vi.fn().mockResolvedValue(priced)
		deps = makeDeps({
			buyer: vi.fn().mockResolvedValue({ existingSeats: 7, userId: 'user-9' }),
			priceSource: vi.fn(() => ({ price })),
		})
		await createTeamInvoice(form(), ctx, deps)
		expect(price).toHaveBeenCalledWith({
			productId: 'product-test',
			quantity: 5,
			existingSeats: 7,
			listUnitAmount: 10_000,
			userId: 'user-9',
			email: 'billing@example.test',
		})
	})

	it('never reads a price from the client', async () => {
		await createTeamInvoice(
			{ ...form(), amount: 1, unitAmount: 1 } as TeamInvoiceFormInput,
			ctx,
			deps,
		)
		const input = vi.mocked(deps.createInvoice).mock.calls[0]![0]
		expect(input.expectedTotal).toBe(40_000)
	})

	describe('validation', () => {
		it.each([
			['one seat', { seats: 1 }],
			['a fractional seat count', { seats: 2.5 }],
			['no company', { companyName: ' ' }],
			['a bad email', { billingEmail: 'not-an-email' }],
			['a half address', { address: { line1: '1 Test St' } }],
			['a long country', { address: { line1: '1 Test St', country: 'Germany' } }],
			['unknown terms', { terms: 'net_90' as 'net_30' }],
			['a link in the company name', { companyName: 'Pay at https://evil.test' }],
			['a www link in the company name', { companyName: 'www.evil.test Ltd' }],
			['a phone number in the company name', { companyName: 'Call 555 123 4567' }],
			['an email in the company name', { companyName: 'billing@evil.test' }],
			['a long company name', { companyName: 'A'.repeat(81) }],
			['a plus sign in the company name', { companyName: 'Call +44 now' }],
			['a colon in the PO number', { poNumber: 'Pay: now' }],
			['a long PO number', { poNumber: 'P'.repeat(41) }],
			['a link in the tax ID', { taxId: 'www.evil.test' }],
			['an email in the address', { address: { line1: 'pay@evil.test', country: 'de' } }],
		])('rejects %s without touching Stripe', async (_label, overrides) => {
			const result = await createTeamInvoice(form(overrides), ctx, deps)
			expect(result.kind).toBe('invalid')
			expect(deps.createInvoice).not.toHaveBeenCalled()
			expect(deps.loadProduct).not.toHaveBeenCalled()
		})

		it('sends more than 100 seats to contact us', async () => {
			const result = await createTeamInvoice(form({ seats: 101 }), ctx, deps)
			expect(result).toEqual({ kind: 'contact-us' })
			expect(deps.createInvoice).not.toHaveBeenCalled()
		})

		it('accepts the range ends', async () => {
			expect((await createTeamInvoice(form({ seats: 2 }), ctx, deps)).kind).toBe(
				'sent',
			)
			expect(
				(await createTeamInvoice(form({ seats: 100 }), ctx, makeDeps())).kind,
			).toBe('sent')
		})

		it('accepts ordinary billing details', async () => {
			const result = await createTeamInvoice(
				form({
					companyName: "Müller & Söhne (Berlin) Ltd.",
					poNumber: 'PO-2026/10 #44',
					taxId: 'DE 123.456.789',
					address: {
						line1: "12 O'Connell St, Unit 3/4",
						city: 'Saint-Étienne',
						postalCode: 'SW1A 1AA',
						country: 'gb',
					},
				}),
				ctx,
				deps,
			)
			expect(result.kind).toBe('sent')
		})

		it('treats an empty address as no address', async () => {
			await createTeamInvoice(
				form({ address: { line1: '', city: '', country: '' } }),
				ctx,
				deps,
			)
			const input = vi.mocked(deps.createInvoice).mock.calls[0]![0]
			expect(input.address).toBeUndefined()
		})
	})

	describe('bot protection and rate limits', () => {
		it('answers a filled honeypot like a success and does nothing', async () => {
			const result = await createTeamInvoice(
				form({ website: 'https://spam.test' }),
				ctx,
				deps,
			)
			expect(result.kind).toBe('confirm-sent')
			expect(deps.rateLimit).not.toHaveBeenCalled()
			expect(deps.sendConfirmation).not.toHaveBeenCalled()
			expect(deps.createInvoice).not.toHaveBeenCalled()
		})

		it('answers a too-fast submit like a success and does nothing', async () => {
			const result = await createTeamInvoice(
				form({ timestamp: new Date(NOW.getTime() - 500).toISOString() }),
				ctx,
				deps,
			)
			expect(result.kind).toBe('confirm-sent')
			expect(deps.sendConfirmation).not.toHaveBeenCalled()
			expect(deps.createInvoice).not.toHaveBeenCalled()
		})

		it('asks for a reload when the form is stale', async () => {
			const result = await createTeamInvoice(
				form({ timestamp: new Date(NOW.getTime() - 2 * 3600_000).toISOString() }),
				ctx,
				deps,
			)
			expect(result.kind).toBe('invalid')
			expect(deps.createInvoice).not.toHaveBeenCalled()
		})

		it('stops at the rate limit', async () => {
			deps = makeDeps({ rateLimit: vi.fn().mockResolvedValue(false) })
			const result = await createTeamInvoice(form(), ctx, deps)
			expect(result).toEqual({ kind: 'rate-limited' })
			expect(deps.rateLimit).toHaveBeenCalledWith({
				ip: '203.0.113.1',
				email: 'billing@example.test',
			})
			expect(deps.createInvoice).not.toHaveBeenCalled()
		})
	})

	describe('sale state', () => {
		it('sends no invoice for a closed product', async () => {
			deps = makeDeps({
				loadProduct: vi.fn().mockResolvedValue({
					...onSaleProduct,
					product: {
						...onSaleProduct.product,
						type: 'cohort',
						fields: {
							state: 'published',
							closeEnrollment: '2026-10-01T00:00:00.000Z',
						},
					},
				}),
			})
			const result = await createTeamInvoice(form(), ctx, deps)
			expect(result).toEqual({ kind: 'not-on-sale' })
			expect(deps.createInvoice).not.toHaveBeenCalled()
			expect(deps.forwardRequest).not.toHaveBeenCalled()
		})

		it('turns an upcoming cohort into a request to support', async () => {
			deps = makeDeps({
				loadProduct: vi.fn().mockResolvedValue({
					...onSaleProduct,
					product: {
						...onSaleProduct.product,
						type: 'cohort',
						fields: {
							state: 'published',
							openEnrollment: '2026-11-01T00:00:00.000Z',
						},
					},
				}),
			})
			const result = await createTeamInvoice(form(), ctx, deps)
			expect(result).toEqual({
				kind: 'requested',
				email: 'billing@example.test',
				when: 'seats-open',
			})
			expect(deps.forwardRequest).toHaveBeenCalledTimes(1)
			expect(deps.createInvoice).not.toHaveBeenCalled()
			expect(deps.priceSource).not.toHaveBeenCalled()
		})

		it('refuses seats beyond what a limited product has left', async () => {
			deps = makeDeps({
				loadProduct: vi.fn().mockResolvedValue({
					...onSaleProduct,
					product: { ...onSaleProduct.product, quantityAvailable: 10 },
					purchaseCount: 8,
				}),
			})
			const result = await createTeamInvoice(form({ seats: 3 }), ctx, deps)
			expect(result).toEqual({ kind: 'not-on-sale' })
		})

		it('forwards to support when invoicing is off for the product', async () => {
			deps = makeDeps({ invoicingEnabled: vi.fn().mockReturnValue(false) })
			const result = await createTeamInvoice(form(), ctx, deps)
			expect(result).toEqual({
				kind: 'requested',
				email: 'billing@example.test',
				when: 'working-day',
			})
			expect(deps.priceSource).not.toHaveBeenCalled()
			expect(deps.createInvoice).not.toHaveBeenCalled()
		})

		it('treats an unknown product as not on sale', async () => {
			deps = makeDeps({ loadProduct: vi.fn().mockResolvedValue(null) })
			expect(await createTeamInvoice(form(), ctx, deps)).toEqual({
				kind: 'not-on-sale',
			})
		})
	})

	describe('price fail-closed', () => {
		it('invoices nothing when the price source is unavailable', async () => {
			deps = makeDeps({
				priceSource: vi.fn(() => ({
					price: vi
						.fn()
						.mockResolvedValue({ kind: 'unavailable', reason: 'front-desk-timeout' }),
				})),
			})
			const result = await createTeamInvoice(form(), ctx, deps)
			expect(result).toEqual({ kind: 'price-unavailable' })
			expect(deps.createInvoice).not.toHaveBeenCalled()
		})

		it('invoices nothing when existing seats are unknowable', async () => {
			deps = makeDeps({ buyer: vi.fn().mockResolvedValue(null) })
			expect(await createTeamInvoice(form(), ctx, deps)).toEqual({
				kind: 'price-unavailable',
			})
			expect(deps.createInvoice).not.toHaveBeenCalled()
		})

		it('reports a voided total mismatch as price unavailable', async () => {
			deps = makeDeps({
				createInvoice: vi
					.fn()
					.mockRejectedValue(new TeamInvoiceTotalMismatch('in_x', 40_000, 41_000)),
			})
			expect(await createTeamInvoice(form(), ctx, deps)).toEqual({
				kind: 'price-unavailable',
			})
		})

		it('reports a Stripe failure as an error and releases the order', async () => {
			deps = makeDeps({
				createInvoice: vi.fn().mockRejectedValue(new Error('stripe down')),
			})
			expect(await createTeamInvoice(form(), ctx, deps)).toEqual({
				kind: 'error',
			})
			expect(deps.idempotency.unlock).toHaveBeenCalled()
			expect(deps.idempotency.set).not.toHaveBeenCalled()
		})
	})

	describe('idempotency', () => {
		it('sends one invoice for the same whole order on the same day', async () => {
			const first = await createTeamInvoice(form(), ctx, deps)
			const second = await createTeamInvoice(form(), ctx, deps)
			expect(first).toEqual(second)
			expect(deps.createInvoice).toHaveBeenCalledTimes(1)
		})

		it('lets a corrected retry through as a new order', async () => {
			deps = makeDeps({
				createInvoice: vi
					.fn()
					.mockRejectedValueOnce(new Error('stripe down'))
					.mockResolvedValue({
						invoiceId: 'in_test',
						customerId: 'cus_test',
						total: 40_000,
						hostedInvoiceUrl: null,
						status: 'open',
					}),
			})
			expect((await createTeamInvoice(form(), ctx, deps)).kind).toBe('error')
			const retry = await createTeamInvoice(
				form({ companyName: 'Example Co GmbH' }),
				ctx,
				deps,
			)
			expect(retry.kind).toBe('sent')
			const [failed, fixed] = vi
				.mocked(deps.createInvoice)
				.mock.calls.map(([input]) => input.orderKey)
			expect(fixed).not.toBe(failed)
		})

		it('keys the order by every field and the UTC day', () => {
			const base = request()
			expect(teamInvoiceOrderKey(base, NOW)).toBe(
				teamInvoiceOrderKey(
					request({ billingEmail: 'BILLING@example.test' }),
					new Date('2026-10-10T23:59:59.000Z'),
				),
			)
			expect(teamInvoiceOrderKey(base, NOW)).not.toBe(
				teamInvoiceOrderKey(base, new Date('2026-10-11T00:00:00.000Z')),
			)
			for (const change of [
				{ seats: 6 },
				{ companyName: 'Other Co' },
				{ poNumber: 'PO-2' },
				{ taxId: 'DE999' },
				{ terms: 'due_on_receipt' as const },
				{ address: { line1: '2 Test St', country: 'de' } },
			]) {
				expect(teamInvoiceOrderKey(request(change), NOW)).not.toBe(
					teamInvoiceOrderKey(base, NOW),
				)
			}
		})

		it('refuses a concurrent duplicate while the first is in flight', async () => {
			deps = makeDeps({
				idempotency: {
					get: vi.fn().mockResolvedValue(null),
					lock: vi.fn().mockResolvedValue(false),
					unlock: vi.fn(),
					set: vi.fn(),
				},
			})
			expect(await createTeamInvoice(form(), ctx, deps)).toEqual({
				kind: 'error',
			})
			expect(deps.createInvoice).not.toHaveBeenCalled()
		})
	})

	describe('email confirmation', () => {
		it('touches no Stripe and prices nothing until the link is used', async () => {
			const result = await startTeamInvoice(form(), ctx, deps)
			expect(result).toEqual({
				kind: 'confirm-sent',
				email: 'billing@example.test',
			})
			expect(deps.createInvoice).not.toHaveBeenCalled()
			expect(deps.priceSource).not.toHaveBeenCalled()
			expect(deps.buyer).not.toHaveBeenCalled()
		})

		it('emails only our words: the product name, the seats and the token', async () => {
			await startTeamInvoice(
				form({ companyName: 'Overdue Accounts Dept', poNumber: 'PAY-NOW' }),
				ctx,
				deps,
			)
			expect(deps.sendConfirmation).toHaveBeenCalledWith({
				to: 'billing@example.test',
				productName: 'Test Course',
				seats: 5,
				token: expect.any(String),
			})
		})

		it('answers an unknown or expired token without invoicing', async () => {
			expect(await confirmTeamInvoice('nope', deps)).toEqual({
				kind: 'expired',
			})
			expect(await confirmTeamInvoice('', deps)).toEqual({ kind: 'expired' })
			expect(deps.createInvoice).not.toHaveBeenCalled()
		})

		it('a second click returns the first invoice, not another', async () => {
			await startTeamInvoice(form(), ctx, deps)
			const token = vi.mocked(deps.sendConfirmation).mock.calls[0]![0].token
			const first = await confirmTeamInvoice(token, deps)
			const second = await confirmTeamInvoice(token, deps)
			expect(first).toEqual({ kind: 'sent', email: 'billing@example.test' })
			expect(second).toEqual(first)
			expect(deps.createInvoice).toHaveBeenCalledTimes(1)
		})

		it('re-checks the sale at confirm time', async () => {
			await startTeamInvoice(form(), ctx, deps)
			const token = vi.mocked(deps.sendConfirmation).mock.calls[0]![0].token
			vi.mocked(deps.loadProduct).mockResolvedValue({
				...onSaleProduct,
				product: { ...onSaleProduct.product, status: 0 },
			})
			expect(await confirmTeamInvoice(token, deps)).toEqual({
				kind: 'not-on-sale',
			})
			expect(deps.createInvoice).not.toHaveBeenCalled()
		})

		it('stops at the daily confirm-email ceiling', async () => {
			deps = makeDeps({
				dailyCeiling: vi.fn(async (kind) => kind !== 'confirmation'),
			})
			expect(await startTeamInvoice(form(), ctx, deps)).toEqual({
				kind: 'rate-limited',
			})
			expect(deps.sendConfirmation).not.toHaveBeenCalled()
		})

		it('stops at the daily invoice ceiling', async () => {
			deps = makeDeps({
				dailyCeiling: vi.fn(async (kind) => kind !== 'invoice'),
			})
			expect(await createTeamInvoice(form(), ctx, deps)).toEqual({
				kind: 'rate-limited',
			})
			expect(deps.createInvoice).not.toHaveBeenCalled()
		})
	})

	describe('seat holds and due dates', () => {
		it('counts seats on open invoices against a limited product', async () => {
			deps = makeDeps({
				loadProduct: vi.fn().mockResolvedValue({
					...onSaleProduct,
					product: { ...onSaleProduct.product, quantityAvailable: 10 },
					purchaseCount: 2,
					heldSeats: 6,
				}),
			})
			expect(await createTeamInvoice(form({ seats: 3 }), ctx, deps)).toEqual({
				kind: 'not-on-sale',
			})
			expect(
				(await createTeamInvoice(form({ seats: 2 }), ctx, makeDeps({
					loadProduct: deps.loadProduct,
				}))).kind,
			).toBe('sent')
		})

		it('makes a cohort invoice fall due by enrollment close', async () => {
			const closes = '2026-10-20T00:00:00.000Z'
			deps = makeDeps({
				loadProduct: vi.fn().mockResolvedValue({
					...onSaleProduct,
					product: {
						...onSaleProduct.product,
						type: 'cohort',
						fields: { state: 'published', closeEnrollment: closes },
					},
				}),
			})
			await createTeamInvoice(form({ terms: 'net_30' }), ctx, deps)
			expect(vi.mocked(deps.createInvoice).mock.calls[0]![0].due).toEqual({
				kind: 'date',
				at: Date.parse(closes) / 1000,
			})
		})

		it.each([
			['a workshop on net 30', 'self-paced', 'net_30', null, { kind: 'days', days: 30 }],
			['due on receipt', 'cohort', 'due_on_receipt', '2026-10-20T00:00:00.000Z', { kind: 'days', days: 0 }],
			['a cohort closing after net 30', 'cohort', 'net_30', '2026-12-01T00:00:00.000Z', { kind: 'days', days: 30 }],
			['a cohort closing within a day', 'live', 'net_30', '2026-10-10T20:00:00.000Z', { kind: 'days', days: 0 }],
		] as const)('due date: %s', (_label, type, terms, closeEnrollment, due) => {
			expect(
				teamInvoiceDue(
					terms,
					{ id: 'p', type, status: 1, fields: { closeEnrollment } },
					NOW,
				),
			).toEqual(due)
		})
	})
})
