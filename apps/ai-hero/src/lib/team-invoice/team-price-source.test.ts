import { describe, expect, it, vi } from 'vitest'

import {
	appBulkPriceSource,
	cappedAtCheckout,
	frontDeskPriceSource,
	teamInvoicingEnabled,
	teamPriceSourceFor,
	type DefaultSaleCoupon,
	type TeamPrice,
	type TeamPriceRequest,
	type TeamPriceSource,
} from './team-price-source'

// Synthetic numbers only. No real team percentages or prices live here.
const LIST = 10_000
const request: TeamPriceRequest = {
	productId: 'product-s00zs',
	quantity: 6,
	existingSeats: 0,
	listUnitAmount: LIST,
}

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})

/** A recorded front-desk `priced` decision, shaped like the agreed contract. */
const PRICED_FIXTURE = {
	kind: 'priced',
	unitAmount: 9_000,
	amount: 54_000,
	policy: 'fixture-team-policy-v1',
	reasons: ['fixture'],
}

describe('frontDeskPriceSource', () => {
	it('posts the agreed contract with the bearer token', async () => {
		const fetch = vi.fn().mockResolvedValue(jsonResponse(PRICED_FIXTURE))
		const source = frontDeskPriceSource({
			url: 'https://front-desk.example.test',
			token: 'fixture-token',
			fetch,
		})

		await source.price({ ...request, existingSeats: 4 })

		expect(fetch).toHaveBeenCalledTimes(1)
		const [url, init] = fetch.mock.calls[0]!
		expect(url).toBe('https://front-desk.example.test/api/pricing/decision')
		expect(init.method).toBe('POST')
		expect(init.headers.authorization).toBe('Bearer fixture-token')
		expect(JSON.parse(init.body)).toEqual({
			productId: 'product-s00zs',
			quantity: 6,
			orderKind: 'team',
			existingSeats: 4,
		})
	})

	it('turns a priced decision into an amount off the list total', async () => {
		const source = frontDeskPriceSource({
			url: 'https://front-desk.example.test',
			token: 't',
			fetch: vi.fn().mockResolvedValue(jsonResponse(PRICED_FIXTURE)),
		})

		await expect(source.price(request)).resolves.toEqual({
			kind: 'priced',
			source: 'front-desk',
			unitAmount: 9_000,
			amount: 54_000,
			policy: 'fixture-team-policy-v1',
			discount: { kind: 'amount-off', amountOff: 6 * LIST - 54_000 },
		})
	})

	it('needs no discount when front-desk prices at list', async () => {
		const source = frontDeskPriceSource({
			url: 'https://front-desk.example.test',
			token: 't',
			fetch: vi.fn().mockResolvedValue(
				jsonResponse({
					...PRICED_FIXTURE,
					unitAmount: LIST,
					amount: 6 * LIST,
				}),
			),
		})
		const price = await source.price(request)
		expect(price.kind === 'priced' && price.discount).toEqual({ kind: 'none' })
	})

	it.each([
		['a non-priced kind', jsonResponse({ kind: 'needs_review', reasons: [] })],
		['an http error', jsonResponse({ error: 'nope' }, 401)],
		['a malformed body', jsonResponse({ kind: 'priced', amount: 'lots' })],
		['a priced answer with no policy', jsonResponse({ ...PRICED_FIXTURE, policy: undefined })],
		['a total above list', jsonResponse({ ...PRICED_FIXTURE, amount: 6 * LIST + 1 })],
		['a zero total', jsonResponse({ ...PRICED_FIXTURE, amount: 0 })],
		['fractional cents', jsonResponse({ ...PRICED_FIXTURE, amount: 54_000.5 })],
		['a 2xx that is not 200', jsonResponse(PRICED_FIXTURE, 201)],
		['a seat price that does not multiply out', jsonResponse({ ...PRICED_FIXTURE, unitAmount: 8_999 })],
	])('fails closed on %s', async (_label, response) => {
		const source = frontDeskPriceSource({
			url: 'https://front-desk.example.test',
			token: 't',
			fetch: vi.fn().mockResolvedValue(response),
		})
		await expect(source.price(request)).resolves.toMatchObject({
			kind: 'unavailable',
		})
	})

	it('fails closed when front-desk is unreachable', async () => {
		const source = frontDeskPriceSource({
			url: 'https://front-desk.example.test',
			token: 't',
			fetch: vi.fn().mockRejectedValue(new TypeError('fetch failed')),
		})
		await expect(source.price(request)).resolves.toEqual({
			kind: 'unavailable',
			reason: 'front-desk-unreachable',
		})
	})

	it('fails closed on a timeout', async () => {
		const hang: typeof fetch = (_url, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () =>
					reject(new DOMException('timed out', 'TimeoutError')),
				)
			})
		const source = frontDeskPriceSource({
			url: 'https://front-desk.example.test',
			token: 't',
			fetch: hang,
			timeoutMs: 20,
		})
		await expect(source.price(request)).resolves.toEqual({
			kind: 'unavailable',
			reason: 'front-desk-unreachable',
		})
	})
})

describe('teamPriceSourceFor', () => {
	const appBulk: TeamPriceSource = {
		price: async () => ({ kind: 'unavailable', reason: 'app' }),
	}
	const frontDesk: TeamPriceSource = {
		price: async () => ({ kind: 'unavailable', reason: 'front-desk' }),
	}

	it('routes C5 to front-desk and everything else to the app rules', async () => {
		await expect(
			teamPriceSourceFor('product-s00zs', { appBulk, frontDesk }).price(request),
		).resolves.toMatchObject({ reason: 'front-desk' })
		await expect(
			teamPriceSourceFor('product-ma254', { appBulk, frontDesk }).price(request),
		).resolves.toMatchObject({ reason: 'app' })
	})

	it('keeps C5 unpriced while front-desk is not configured', async () => {
		await expect(
			teamPriceSourceFor('product-s00zs', { appBulk, frontDesk: null }).price(
				request,
			),
		).resolves.toEqual({
			kind: 'unavailable',
			reason: 'front-desk-not-configured',
		})
		expect(teamInvoicingEnabled('product-s00zs', false)).toBe(false)
		expect(teamInvoicingEnabled('product-s00zs', true)).toBe(true)
		expect(teamInvoicingEnabled('product-ma254', false)).toBe(true)
	})
})

describe('cappedAtCheckout', () => {
	const fixed = (price: TeamPrice): TeamPriceSource => ({
		price: async () => price,
	})
	const at = (amount: number): TeamPrice => ({
		kind: 'priced',
		source: 'app-bulk',
		unitAmount: amount / 6,
		amount,
		policy: 'app-bulk:x',
		discount: { kind: 'none' },
	})
	const frontDesk = at(54_000)

	it('keeps a front-desk price at or below checkout', async () => {
		await expect(
			cappedAtCheckout(fixed(frontDesk), fixed(at(60_000))).price(request),
		).resolves.toBe(frontDesk)
		await expect(
			cappedAtCheckout(fixed(frontDesk), fixed(at(54_000))).price(request),
		).resolves.toBe(frontDesk)
	})

	it('refuses a front-desk price above checkout', async () => {
		await expect(
			cappedAtCheckout(fixed(frontDesk), fixed(at(50_000))).price(request),
		).resolves.toEqual({ kind: 'unavailable', reason: 'above-checkout' })
	})

	it('refuses when checkout is not knowable', async () => {
		await expect(
			cappedAtCheckout(
				fixed(frontDesk),
				fixed({ kind: 'unavailable', reason: 'app-price-error' }),
			).price(request),
		).resolves.toEqual({
			kind: 'unavailable',
			reason: 'checkout-cap-app-price-error',
		})
	})

	it('caps C5 through the router', async () => {
		await expect(
			teamPriceSourceFor('product-s00zs', {
				appBulk: fixed(at(50_000)),
				frontDesk: fixed(frontDesk),
			}).price(request),
		).resolves.toMatchObject({ reason: 'above-checkout' })
	})
})

const noSale = vi.fn(async (): Promise<DefaultSaleCoupon | null> => null)

describe('appBulkPriceSource', () => {
	const appRequest: TeamPriceRequest = {
		productId: 'product-ma254',
		quantity: 5,
		existingSeats: 0,
		listUnitAmount: LIST,
	}
	const bulk = {
		quantity: 5,
		unitPrice: 100,
		fullPrice: 500,
		calculatedPrice: 400,
		appliedDiscountType: 'bulk',
		appliedMerchantCoupon: { id: 'mc_bulk', percentageDiscount: '0.2' },
	}

	it('prices with the bulk coupon checkout would use', async () => {
		const stripeCouponIdFor = vi.fn().mockResolvedValue('stripe_bulk_coupon')
		const source = appBulkPriceSource({
			defaultSaleCoupon: noSale,
			formatPrice: vi.fn().mockResolvedValue(bulk),
			stripeCouponIdFor,
		})

		await expect(source.price(appRequest)).resolves.toEqual({
			kind: 'priced',
			source: 'app-bulk',
			unitAmount: 8_000,
			amount: 40_000,
			policy: 'app-bulk:20',
			discount: { kind: 'stripe-coupon', stripeCouponId: 'stripe_bulk_coupon' },
		})
		expect(stripeCouponIdFor).toHaveBeenCalledWith('mc_bulk')
	})

	it('prices at list below the bulk ladder', async () => {
		const source = appBulkPriceSource({
			defaultSaleCoupon: noSale,
			formatPrice: vi.fn().mockResolvedValue({
				quantity: 2,
				unitPrice: 100,
				fullPrice: 200,
				calculatedPrice: 200,
				appliedDiscountType: 'none',
			}),
			stripeCouponIdFor: vi.fn(),
		})
		await expect(
			source.price({ ...appRequest, quantity: 2 }),
		).resolves.toMatchObject({
			kind: 'priced',
			amount: 20_000,
			discount: { kind: 'none' },
		})
	})

	it.each([
		['a percentage coupon with no sale running', { ...bulk, appliedDiscountType: 'percentage' }],
		['PPP', { ...bulk, appliedDiscountType: 'ppp' }],
		['an upgrade credit', { ...bulk, fixedDiscountForUpgrade: 50 }],
		['a different quantity', { ...bulk, quantity: 4 }],
		['a discount with no coupon', { ...bulk, appliedDiscountType: 'none', appliedMerchantCoupon: undefined }],
		['a price above list', { ...bulk, calculatedPrice: 600 }],
	])('refuses %s', async (_label, formatted) => {
		const source = appBulkPriceSource({
			defaultSaleCoupon: noSale,
			formatPrice: vi.fn().mockResolvedValue(formatted),
			stripeCouponIdFor: vi.fn().mockResolvedValue('stripe_bulk_coupon'),
		})
		await expect(source.price(appRequest)).resolves.toMatchObject({
			kind: 'unavailable',
		})
	})

	it('fails closed when the bulk coupon has no Stripe id', async () => {
		const source = appBulkPriceSource({
			defaultSaleCoupon: noSale,
			formatPrice: vi.fn().mockResolvedValue(bulk),
			stripeCouponIdFor: vi.fn().mockResolvedValue(null),
		})
		await expect(source.price(appRequest)).resolves.toEqual({
			kind: 'unavailable',
			reason: 'app-bulk-coupon-missing',
		})
	})

	describe('with a site sale running', () => {
		const sale = (over: Partial<DefaultSaleCoupon>): DefaultSaleCoupon => ({
			merchantCouponId: 'mc_sale',
			couponId: 'coupon_sale',
			stripeCouponId: 'stripe_sale',
			percentageDiscount: 0.4,
			...over,
		})

		it('prices with the sale checkout passes in', async () => {
			const formatPrice = vi.fn().mockResolvedValue(bulk)
			const running = sale({ percentageDiscount: 0.1 })
			const source = appBulkPriceSource({
				formatPrice,
				stripeCouponIdFor: vi.fn().mockResolvedValue('stripe_bulk_coupon'),
				defaultSaleCoupon: vi.fn().mockResolvedValue(running),
			})
			await source.price(appRequest)
			expect(formatPrice).toHaveBeenCalledWith(appRequest, running)
		})

		it('takes the sale when it beats the bulk ladder checkout picked', async () => {
			const source = appBulkPriceSource({
				formatPrice: vi.fn().mockResolvedValue(bulk),
				stripeCouponIdFor: vi.fn().mockResolvedValue('stripe_bulk_coupon'),
				defaultSaleCoupon: vi.fn().mockResolvedValue(sale({})),
			})
			await expect(source.price(appRequest)).resolves.toEqual({
				kind: 'priced',
				source: 'app-bulk',
				unitAmount: 6_000,
				amount: 30_000,
				policy: 'app-sale:40',
				discount: { kind: 'stripe-coupon', stripeCouponId: 'stripe_sale' },
			})
		})

		it('keeps the bulk ladder when it beats the sale', async () => {
			const source = appBulkPriceSource({
				formatPrice: vi.fn().mockResolvedValue(bulk),
				stripeCouponIdFor: vi.fn().mockResolvedValue('stripe_bulk_coupon'),
				defaultSaleCoupon: vi
					.fn()
					.mockResolvedValue(sale({ percentageDiscount: 0.1 })),
			})
			await expect(source.price(appRequest)).resolves.toMatchObject({
				amount: 40_000,
				policy: 'app-bulk:20',
			})
		})

		it('accepts checkout applying the sale itself', async () => {
			const source = appBulkPriceSource({
				formatPrice: vi.fn().mockResolvedValue({
					...bulk,
					calculatedPrice: 300,
					appliedDiscountType: 'percentage',
					appliedMerchantCoupon: { id: 'mc_sale', percentageDiscount: 0.4 },
				}),
				stripeCouponIdFor: vi.fn(),
				defaultSaleCoupon: vi.fn().mockResolvedValue(sale({})),
			})
			await expect(source.price(appRequest)).resolves.toMatchObject({
				amount: 30_000,
				policy: 'app-sale:40',
				discount: { kind: 'stripe-coupon', stripeCouponId: 'stripe_sale' },
			})
		})

		it('turns a per-seat fixed sale into one amount off for every seat', async () => {
			const source = appBulkPriceSource({
				formatPrice: vi.fn().mockResolvedValue(bulk),
				stripeCouponIdFor: vi.fn().mockResolvedValue('stripe_bulk_coupon'),
				defaultSaleCoupon: vi.fn().mockResolvedValue(
					sale({ percentageDiscount: null, amountDiscount: 3_000 }),
				),
			})
			await expect(source.price(appRequest)).resolves.toMatchObject({
				amount: 35_000,
				policy: 'app-sale:fixed',
				discount: { kind: 'amount-off', amountOff: 15_000 },
			})
		})

		it('refuses a percentage coupon that is not the running sale', async () => {
			const source = appBulkPriceSource({
				formatPrice: vi.fn().mockResolvedValue({
					...bulk,
					appliedDiscountType: 'percentage',
					appliedMerchantCoupon: { id: 'mc_other', percentageDiscount: 0.5 },
				}),
				stripeCouponIdFor: vi.fn(),
				defaultSaleCoupon: vi.fn().mockResolvedValue(sale({})),
			})
			await expect(source.price(appRequest)).resolves.toEqual({
				kind: 'unavailable',
				reason: 'app-discount-percentage',
			})
		})
	})

	it('fails closed when pricing throws', async () => {
		const source = appBulkPriceSource({
			defaultSaleCoupon: noSale,
			formatPrice: vi.fn().mockRejectedValue(new Error('db down')),
			stripeCouponIdFor: vi.fn(),
		})
		await expect(source.price(appRequest)).resolves.toEqual({
			kind: 'unavailable',
			reason: 'app-price-error',
		})
	})
})
