import {
	SYNTHETIC_LIST,
	SYNTHETIC_POLICY_PRODUCT,
	SYNTHETIC_POLICY_VERSION,
	syntheticPolicy,
} from '@/lib/c5-pricing/synthetic-policy.test-fixture'
import { price } from '@ai-hero/front-desk-support/pricing'
import { describe, expect, it, vi } from 'vitest'

import {
	appBulkPriceSource,
	cappedAtCheckout,
	enginePriceSource,
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

const policyRead = async () => ({
	ok: true as const,
	value: { version: SYNTHETIC_POLICY_VERSION, policy: syntheticPolicy() },
})
const noQuotes = async () => ({ ok: true as const, value: [] })
const inEarlyWindow = () => new Date('2030-01-05T00:00:00.000Z')
const engineRequest: TeamPriceRequest = {
	productId: 'product-s00zs',
	quantity: 6,
	existingSeats: 0,
	listUnitAmount: SYNTHETIC_LIST,
}

describe('enginePriceSource', () => {
	it('prices a team order from new plus existing seats through the vendored engine', async () => {
		const source = enginePriceSource({
			policy: policyRead,
			quotes: noQuotes,
			price,
			now: inEarlyWindow,
		})
		// Synthetic early bands: 5+ seats 25%, 10+ seats 30%.
		await expect(source.price(engineRequest)).resolves.toEqual({
			kind: 'priced',
			source: 'engine',
			unitAmount: 75_000,
			amount: 450_000,
			policy: `${SYNTHETIC_POLICY_VERSION}:team`,
			discount: { kind: 'amount-off', amountOff: 150_000 },
		})
		await expect(
			source.price({ ...engineRequest, existingSeats: 4 }),
		).resolves.toMatchObject({ unitAmount: 70_000, amount: 420_000 })
	})

	it("reads the billing email's binding quotes fresh and fails closed without them", async () => {
		const quotes = vi.fn(async () => ({ ok: false as const, reason: 'down' }))
		const source = enginePriceSource({
			policy: policyRead,
			quotes,
			price,
			now: inEarlyWindow,
		})
		await expect(
			source.price({ ...engineRequest, email: 'team@example.test' }),
		).resolves.toEqual({
			kind: 'unavailable',
			reason: 'engine-quotes-unavailable',
		})
		expect(quotes).toHaveBeenCalledWith({
			email: 'team@example.test',
			productId: 'product-s00zs',
			quantity: 6,
			fresh: true,
		})
	})

	it('invoices a binding team quote below the band price', async () => {
		const source = enginePriceSource({
			policy: policyRead,
			quotes: async () => ({
				ok: true as const,
				value: [
					{
						amount: 400_000,
						basis: 'Total' as const,
						currency: 'USD',
						expiresAt: null,
						product: SYNTHETIC_POLICY_PRODUCT,
						quantity: 6,
						ref: 'quote-synthetic@1#line-1',
					},
				],
			}),
			price,
			now: inEarlyWindow,
		})
		await expect(
			source.price({ ...engineRequest, email: 'team@example.test' }),
		).resolves.toMatchObject({ kind: 'priced', amount: 400_000 })
	})

	it.each([
		[
			'no policy',
			{ policy: async () => ({ ok: false as const, reason: 'x' }) },
			'engine-policy-unavailable',
		],
		[
			'a closed window',
			{ now: () => new Date('2031-01-01T00:00:00.000Z') },
			'engine-closed',
		],
		['a list price the policy does not know', { list: 99_999 }, 'engine-held'],
	])('is unavailable with %s', async (_, over, reason) => {
		const { list, ...deps } = over as { list?: number } & Record<
			string,
			unknown
		>
		const source = enginePriceSource({
			policy: policyRead,
			quotes: noQuotes,
			price,
			now: inEarlyWindow,
			...(deps as object),
		})
		await expect(
			source.price({
				...engineRequest,
				listUnitAmount: list ?? SYNTHETIC_LIST,
			}),
		).resolves.toEqual({ kind: 'unavailable', reason })
	})
})

describe('teamPriceSourceFor', () => {
	const appBulk: TeamPriceSource = {
		price: async () => ({ kind: 'unavailable', reason: 'app' }),
	}
	const engine: TeamPriceSource = {
		price: async () => ({ kind: 'unavailable', reason: 'engine' }),
	}

	it('routes C5 to the in-process engine and everything else to the app rules', async () => {
		await expect(
			teamPriceSourceFor('product-s00zs', { appBulk, engine }).price(request),
		).resolves.toMatchObject({ reason: 'engine' })
		await expect(
			teamPriceSourceFor('product-ma254', { appBulk, engine }).price(request),
		).resolves.toMatchObject({ reason: 'app' })
	})

	it('keeps C5 unpriced while front-desk is not configured', async () => {
		await expect(
			teamPriceSourceFor('product-s00zs', { appBulk, engine: null }).price(
				request,
			),
		).resolves.toEqual({
			kind: 'unavailable',
			reason: 'engine-not-configured',
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
	const enginePrice = at(54_000)

	it('keeps an engine price at or below checkout', async () => {
		await expect(
			cappedAtCheckout(fixed(enginePrice), fixed(at(60_000))).price(request),
		).resolves.toBe(enginePrice)
		await expect(
			cappedAtCheckout(fixed(enginePrice), fixed(at(54_000))).price(request),
		).resolves.toBe(enginePrice)
	})

	it('refuses an engine price above checkout', async () => {
		await expect(
			cappedAtCheckout(fixed(enginePrice), fixed(at(50_000))).price(request),
		).resolves.toEqual({ kind: 'unavailable', reason: 'above-checkout' })
	})

	it('refuses when checkout is not knowable', async () => {
		await expect(
			cappedAtCheckout(
				fixed(enginePrice),
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
				engine: fixed(enginePrice),
			}).price(request),
		).resolves.toMatchObject({ reason: 'above-checkout' })
	})
})

const noSale = vi.fn(async (): Promise<DefaultSaleCoupon | null> => null)

describe('appBulkPriceSource for an authoritative-priced product', () => {
	const authoritative = (
		over: Partial<{ kind: string; purchasable: boolean; amountCents: number }>,
	) => ({
		quantity: 6,
		unitPrice: 1000,
		fullPrice: 6000,
		calculatedPrice: 4500,
		appliedDiscountType: 'fixed',
		appliedMerchantCoupon: { id: 'authoritative-discount' },
		authoritative: {
			kind: 'priced',
			purchasable: true,
			amountCents: 450_000,
			policyVersion: 'synthetic',
			...over,
		},
	})
	const source = (formatted: unknown) =>
		appBulkPriceSource({
			defaultSaleCoupon: noSale,
			formatPrice: vi.fn().mockResolvedValue(formatted),
			stripeCouponIdFor: vi.fn(),
		})

	it('caps at the decision checkout would charge', async () => {
		await expect(
			source(authoritative({})).price({ ...request, listUnitAmount: 100_000 }),
		).resolves.toEqual({
			kind: 'priced',
			source: 'app-bulk',
			unitAmount: 75_000,
			amount: 450_000,
			policy: 'app-authoritative:synthetic',
			discount: { kind: 'amount-off', amountOff: 150_000 },
		})
	})

	it('is unknowable when checkout would not charge the decision', async () => {
		await expect(
			source(authoritative({ kind: 'bounded', purchasable: false })).price({
				...request,
				listUnitAmount: 100_000,
			}),
		).resolves.toEqual({
			kind: 'unavailable',
			reason: 'app-authoritative-bounded',
		})
	})
})

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
		[
			'a percentage coupon with no sale running',
			{ ...bulk, appliedDiscountType: 'percentage' },
		],
		['PPP', { ...bulk, appliedDiscountType: 'ppp' }],
		['an upgrade credit', { ...bulk, fixedDiscountForUpgrade: 50 }],
		['a different quantity', { ...bulk, quantity: 4 }],
		[
			'a discount with no coupon',
			{
				...bulk,
				appliedDiscountType: 'none',
				appliedMerchantCoupon: undefined,
			},
		],
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
				defaultSaleCoupon: vi
					.fn()
					.mockResolvedValue(
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
