import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	lookupUser: vi.fn(),
	purchases: vi.fn(),
	coupons: vi.fn(),
	prices: vi.fn(),
	charge: vi.fn(),
	refunds: vi.fn(),
	disputes: vi.fn(),
	session: vi.fn(),
	lineItems: vi.fn(),
	transfers: vi.fn(),
	purchaseFirst: vi.fn(),
	spentBy: vi.fn(async (): Promise<string[]> => []),
}))
vi.mock('@/lib/c5-pricing/purchase-decision-store', () => ({
	drizzleC5DecisionStore: () => ({ spentBy: mocks.spentBy }),
}))
vi.mock('@/lib/c5-pricing/config', () => ({
	c5DecisionCutover: () => new Date('2030-01-01T00:00:00Z'),
}))
vi.mock('../support/integration', () => ({
	integration: { lookupUser: mocks.lookupUser },
}))
vi.mock('@/db', () => ({
	db: {
		query: {
			purchases: {
				findMany: mocks.purchases,
				findFirst: mocks.purchaseFirst,
			},
			coupon: { findMany: mocks.coupons },
			prices: { findMany: mocks.prices },
			purchaseUserTransfer: { findMany: mocks.transfers },
		},
	},
}))
vi.mock('@/coursebuilder/stripe-provider', () => ({
	stripeProvider: {
		options: {
			paymentsAdapter: {
				stripe: {
					charges: { retrieve: mocks.charge },
					refunds: { list: mocks.refunds },
					disputes: { list: mocks.disputes },
					checkout: {
						sessions: {
							retrieve: mocks.session,
							listLineItems: mocks.lineItems,
						},
					},
				},
			},
		},
	},
}))
import { hooks } from './hooks'

beforeEach(() => {
	vi.clearAllMocks()
	mocks.transfers.mockResolvedValue([])
	mocks.purchaseFirst.mockResolvedValue({ userId: 'test-user' })
})
describe('front-desk read hooks', () => {
	it('maps a customer and handles a missing customer', async () => {
		mocks.lookupUser
			.mockResolvedValueOnce({ id: 'test-user', email: 'test@example.invalid' })
			.mockResolvedValueOnce(null)
		expect(await hooks.customerByEmail('test@example.invalid')).toEqual({
			id: 'test-user',
			email: 'test@example.invalid',
			name: null,
			emailAliases: [],
		})
		expect(await hooks.customerByEmail('missing@example.invalid')).toBeNull()
	})
	it('keeps merchant ids separate from Stripe identifiers and maps seats', async () => {
		mocks.purchases.mockResolvedValue([
			{
				id: 'test-purchase',
				productId: 'test-product',
				product: { name: 'Test Product' },
				totalAmount: '199.00',
				createdAt: new Date('2026-01-01'),
				status: 'Valid',
				bulkCoupon: { maxUses: 3 },
				merchantChargeId: 'merchant-test',
				merchantCharge: { identifier: 'ch_test' },
			},
			{
				id: 'test-free',
				productId: 'test-product',
				totalAmount: 0,
				createdAt: new Date('2026-01-01'),
				status: 'Valid',
				merchantChargeId: null,
			},
		])
		const purchases = await hooks.purchasesForUser('test-user')
		expect(purchases[0]).toMatchObject({
			merchantChargeId: 'merchant-test',
			stripeChargeId: 'ch_test',
			amount: 19900,
			seats: 3,
		})
		expect(purchases[1]).toMatchObject({
			merchantChargeId: null,
			stripeChargeId: null,
			amount: 0,
			seats: 1,
		})
	})
	it('never treats a non-charge merchant identifier as a Stripe charge id', async () => {
		mocks.purchases.mockResolvedValue([
			{
				id: 'test-purchase',
				productId: 'test-product',
				totalAmount: 0,
				createdAt: new Date('2026-01-01'),
				status: 'Valid',
				merchantChargeId: 'merchant-test',
				merchantCharge: { identifier: 'pi_test' },
			},
		])
		expect(
			(await hooks.purchasesForUser('test-user'))[0]?.stripeChargeId,
		).toBeNull()
	})
	it('reads all refund pages and dispute state with presentment details', async () => {
		mocks.charge.mockResolvedValue({
			id: 'ch_test',
			amount: 19900,
			currency: 'usd',
			amount_refunded: 2000,
			disputed: true,
			presentment_details: {
				presentment_amount: 18000,
				presentment_currency: 'eur',
			},
		})
		mocks.refunds
			.mockResolvedValueOnce({ data: [{ id: 're_one' }], has_more: true })
			.mockResolvedValueOnce({ data: [{ id: 're_two' }], has_more: false })
		mocks.disputes.mockResolvedValue({ data: [{ status: 'needs_response' }] })
		expect(await hooks.chargeState('ch_test')).toEqual({
			stripeChargeId: 'ch_test',
			amount: 19900,
			currency: 'usd',
			amountRefunded: 2000,
			refundCount: 2,
			disputed: true,
			disputeStatus: 'needs_response',
			presentmentAmount: 18000,
			presentmentCurrency: 'eur',
		})
		expect(mocks.refunds).toHaveBeenLastCalledWith({
			charge: 'ch_test',
			limit: 100,
			starting_after: 're_one',
		})
	})
	it('preserves missing presentment information instead of inventing it', async () => {
		mocks.charge.mockResolvedValue({
			id: 'ch_test',
			amount: 100,
			currency: 'usd',
			amount_refunded: 0,
			disputed: false,
		})
		mocks.refunds.mockResolvedValue({ data: [], has_more: false })
		expect(await hooks.chargeState('ch_test')).toMatchObject({
			refundCount: 0,
			disputeStatus: null,
			presentmentAmount: null,
			presentmentCurrency: null,
		})
		expect(mocks.disputes).not.toHaveBeenCalled()
	})
	const settledStripe = () => {
		mocks.charge.mockResolvedValue({
			id: 'ch_test',
			amount: 30000,
			currency: 'usd',
			amount_refunded: 0,
			disputed: false,
			paid: true,
			captured: true,
			status: 'succeeded',
			payment_intent: 'pi_test',
		})
		mocks.refunds.mockResolvedValue({ data: [], has_more: false })
		mocks.session.mockResolvedValue({
			id: 'cs_test',
			status: 'complete',
			payment_status: 'paid',
			payment_intent: { id: 'pi_test' },
		})
		mocks.lineItems.mockResolvedValue({
			has_more: false,
			data: [
				{
					price: { product: 'prod_test_cc' },
					quantity: 1,
					currency: 'usd',
					amount_total: 27000,
					amount_tax: 2000,
				},
				{
					price: { product: { id: 'prod_test_other' } },
					quantity: 1,
					currency: 'usd',
					amount_total: 3000,
					amount_tax: 0,
				},
			],
		})
	}
	const crashCourse = (over: Record<string, unknown> = {}) => ({
		id: 'cc',
		productId: 'product-ma254',
		status: 'Valid',
		totalAmount: '199.00',
		couponId: null,
		bulkCouponId: null,
		redeemedBulkCouponId: null,
		merchantCharge: {
			identifier: 'ch_test',
			merchantProduct: {
				productId: 'product-ma254',
				identifier: 'prod_test_cc',
			},
		},
		merchantSession: { identifier: 'cs_test' },
		...over,
	})
	const askC5 = {
		email: 'buyer@example.test',
		productId: 'product-s00zs',
		quantity: 1,
		orderKind: 'individual',
	} as const
	it('treats a coupon with no MerchantCoupon relation as ambiguous, without asking Stripe', async () => {
		mocks.lookupUser.mockResolvedValue({ id: 'test-user' })
		mocks.prices.mockResolvedValue([
			{ id: 'price-test', unitAmount: '1000.00' },
		])
		mocks.purchases.mockResolvedValue([
			crashCourse({ id: 'a', couponId: 'coupon-orphan' }),
		])
		mocks.coupons.mockResolvedValue([
			{ id: 'coupon-orphan', merchantCoupon: null },
		])
		settledStripe()
		const facts = await hooks.pricingFacts(askC5)
		expect(facts?.facts.credit).toEqual({ gap: 'PaymentAmbiguous' })
		mocks.coupons.mockResolvedValue([
			{ id: 'coupon-orphan', merchantCoupon: { type: null } },
		])
		expect((await hooks.pricingFacts(askC5))?.facts.credit).toEqual({
			gap: 'PaymentAmbiguous',
		})
		expect(mocks.charge).not.toHaveBeenCalled()
		expect(mocks.session).not.toHaveBeenCalled()
	})
	describe('when the two charge reads disagree', () => {
		const clean = {
			id: 'ch_test',
			amount: 30000,
			currency: 'usd',
			amount_refunded: 0,
			refunded: false,
			disputed: false,
			paid: true,
			captured: true,
			status: 'succeeded',
			payment_intent: 'pi_test',
		}
		const creditWith = async (
			first: Record<string, unknown>,
			second: Record<string, unknown>,
		) => {
			mocks.lookupUser.mockResolvedValue({ id: 'test-user' })
			mocks.prices.mockResolvedValue([
				{ id: 'price-test', unitAmount: '1000.00' },
			])
			mocks.purchases.mockResolvedValue([crashCourse()])
			settledStripe()
			mocks.disputes.mockResolvedValue({ data: [{ status: 'needs_response' }] })
			mocks.charge
				.mockReset()
				.mockResolvedValueOnce({ ...clean, ...first })
				.mockResolvedValueOnce({ ...clean, ...second })
			const facts = await hooks.pricingFacts(askC5)
			expect(mocks.charge).toHaveBeenCalledTimes(2)
			return facts?.facts.credit
		}
		it.each([
			[
				'a newer full refund excludes the source',
				{},
				{ amount_refunded: 30000, refunded: true },
				{
					value: null,
					sourceRefs: ['ai-hero:purchase:cc#excluded:refunded'],
				},
			],
			[
				'a newer refunded flag alone excludes the source',
				{},
				{ refunded: true },
				{
					value: null,
					sourceRefs: ['ai-hero:purchase:cc#excluded:refunded'],
				},
			],
			[
				'a newer partial refund holds',
				{},
				{ amount_refunded: 5000 },
				{ gap: 'PaymentAmbiguous' },
			],
			[
				'a newer dispute holds',
				{},
				{ disputed: true },
				{ gap: 'PaymentAmbiguous' },
			],
			[
				'an earlier partial refund still holds',
				{ amount_refunded: 5000 },
				{},
				{ gap: 'PaymentAmbiguous' },
			],
			[
				'an earlier dispute still holds',
				{ disputed: true },
				{},
				{ gap: 'PaymentAmbiguous' },
			],
		])('%s', async (_, first, second, credit) => {
			expect(await creditWith(first, second)).toEqual(credit)
		})
		it('an earlier refund on the paginated list still holds', async () => {
			mocks.lookupUser.mockResolvedValue({ id: 'test-user' })
			mocks.prices.mockResolvedValue([
				{ id: 'price-test', unitAmount: '1000.00' },
			])
			mocks.purchases.mockResolvedValue([crashCourse()])
			settledStripe()
			mocks.refunds.mockResolvedValue({
				data: [{ id: 're_test' }],
				has_more: false,
			})
			expect((await hooks.pricingFacts(askC5))?.facts.credit).toEqual({
				gap: 'PaymentAmbiguous',
			})
		})
	})
	it("reads the credit source's transfer chain and spends it for a C5 purchase from before the cutover", async () => {
		mocks.lookupUser.mockResolvedValue({ id: 'test-user' })
		mocks.prices.mockResolvedValue([
			{ id: 'price-test', unitAmount: '1000.00' },
		])
		mocks.purchases.mockResolvedValue([crashCourse()])
		settledStripe()
		const moved = {
			id: 'transfer-test',
			purchaseId: 'c5-moved',
			sourceUserId: 'test-user',
			targetUserId: 'test-recipient',
			transferState: 'COMPLETED',
			purchase: {
				id: 'c5-moved',
				userId: 'test-recipient',
				productId: 'product-s00zs',
				status: 'Valid',
				createdAt: new Date('2029-06-01T00:00:00Z'),
				bulkCouponId: null,
				redeemedBulkCouponId: null,
			},
		}
		// The Crash Course purchase never moved; its holder moved a C5 purchase.
		mocks.transfers.mockResolvedValueOnce([]).mockResolvedValueOnce([moved])
		const facts = await hooks.pricingFacts(askC5)
		expect(facts?.facts.credit).toMatchObject({ value: { paid: 25000 } })
		expect(facts?.facts.creditUse).toEqual({
			value: 'spent',
			sourceRefs: [
				'ai-hero:purchase-transfers:purchase:cc',
				'ai-hero:purchase:c5-moved#before-cutover',
			],
		})
		const ops = {
			eq: (column: string, value: string) => `${column}=${value}`,
			inArray: (column: string, values: string[]) =>
				`${column} in ${values.join(',')}`,
		}
		const [chainQuery, movedQuery] = mocks.transfers.mock.calls.map(
			(call) => call[0],
		)
		expect(chainQuery.where({ purchaseId: 'purchase' }, ops)).toBe(
			'purchase=cc',
		)
		expect(movedQuery.with).toEqual({ purchase: true })
		expect(movedQuery.where({ sourceUserId: 'source' }, ops)).toBe(
			'source in test-user',
		)
		mocks.transfers.mockRejectedValue(new Error('db down'))
		const down = await hooks.pricingFacts(askC5)
		expect(down?.facts.credit).toMatchObject({ value: { paid: 25000 } })
		expect(down?.facts.creditUse).toEqual({ gap: 'FactsUnavailable' })
	})
	it('holds credit when the purchase session is missing at Stripe', async () => {
		mocks.lookupUser.mockResolvedValue({ id: 'test-user' })
		mocks.prices.mockResolvedValue([
			{ id: 'price-test', unitAmount: '1000.00' },
		])
		mocks.purchases.mockResolvedValue([crashCourse()])
		settledStripe()
		mocks.session.mockRejectedValue(
			Object.assign(new Error('missing'), { code: 'resource_missing' }),
		)
		expect((await hooks.pricingFacts(askC5))?.facts.credit).toEqual({
			gap: 'PaymentAmbiguous',
		})
		mocks.session.mockRejectedValue(new Error('stripe down'))
		expect((await hooks.pricingFacts(askC5))?.facts.credit).toEqual({
			gap: 'FactsUnavailable',
		})
	})
	it('builds pricing facts from read-only DB rows and the settled Stripe charge', async () => {
		mocks.lookupUser.mockResolvedValue({
			id: 'test-user',
			email: 'buyer@example.test',
		})
		mocks.prices.mockResolvedValue([
			{ id: 'price-test', unitAmount: '1000.00' },
		])
		mocks.purchases.mockResolvedValue([
			crashCourse({ couponId: 'coupon-test' }),
			{
				id: 'c4',
				productId: 'product-pqkk5',
				status: 'Valid',
				totalAmount: 0,
				merchantCharge: null,
			},
			{
				id: 'team',
				productId: 'product-s00zs',
				status: 'Valid',
				totalAmount: '4000.00',
				createdAt: new Date('2030-02-01T00:00:00Z'),
				bulkCouponId: 'bulk-test',
				bulkCoupon: { maxUses: 4 },
				merchantCharge: { identifier: 'pi_test' },
			},
		])
		mocks.coupons.mockResolvedValue([
			{ id: 'coupon-test', merchantCoupon: { type: 'special' } },
		])
		// Gross charge 30000 covers two lines. The credit is the Crash Course
		// line, 27000 less 2000 tax, not the charge or the rounded Purchase total.
		settledStripe()
		const facts = await hooks.pricingFacts(askC5)
		expect(facts).toEqual({
			product: {
				appProductId: 'product-s00zs',
				merchantPriceId: 'price-test',
				merchantUnit: 100000,
				sourceRefs: ['ai-hero:price:price-test'],
			},
			buyer: { userId: 'test-user', sourceRefs: ['ai-hero:user:test-user'] },
			quantity: 1,
			facts: {
				order: { value: 'individual', sourceRefs: ['request:orderKind'] },
				legend: {
					value: 'no',
					sourceRefs: [
						'product:product-3vfob',
						'product:product-9wdta',
						'product:product-wdhub',
						'product:product-7t9ek',
						'product:product-pqkk5',
						'product:product-ma254',
					],
				},
				ppp: { gap: 'FactsUnavailable' },
				alumni: { value: 'c4', sourceRefs: ['ai-hero:purchase:c4'] },
				credit: {
					value: { paid: 25000, source: 'cc' },
					sourceRefs: [
						'ai-hero:purchase:cc',
						'stripe:charge:ch_test',
						'stripe:checkout-session:cs_test#product:prod_test_cc',
					],
				},
				creditUse: {
					value: 'available',
					sourceRefs: [
						'ai-hero:purchase-transfers:purchase:cc',
						'ai-hero:c5-decision-ledger',
					],
				},
				existingSeats: { value: 4, sourceRefs: ['ai-hero:purchase:team'] },
			},
		})
		expect(mocks.spentBy).toHaveBeenCalledWith('cc')
		expect(mocks.charge).toHaveBeenCalledWith('ch_test')
		expect(mocks.session).toHaveBeenCalledWith('cs_test')
		expect(mocks.lineItems).toHaveBeenCalledWith('cs_test', { limit: 100 })
		expect(mocks.coupons).toHaveBeenCalledTimes(1)
		const query = mocks.purchases.mock.calls[0]![0]
		expect(
			query.where(
				{ userId: 'owner', productId: 'product' },
				{
					eq: (column: string, value: string) => ({ column, value }),
					inArray: (column: string, values: string[]) => ({ column, values }),
					and: (...clauses: unknown[]) => clauses,
				},
			),
		).toEqual([
			{ column: 'owner', value: 'test-user' },
			{
				column: 'product',
				values: [
					'product-s00zs',
					'product-3vfob',
					'product-9wdta',
					'product-wdhub',
					'product-7t9ek',
					'product-pqkk5',
					'product-ma254',
				],
			},
		])
		expect(query.with).toEqual({
			bulkCoupon: true,
			merchantCharge: { with: { merchantProduct: true } },
			merchantSession: true,
		})
	})
	it('marks every ownership fact IdentityUnverified for an email with no account', async () => {
		mocks.lookupUser.mockResolvedValue(null)
		mocks.prices.mockResolvedValue([
			{ id: 'price-test', unitAmount: '1000.00' },
		])
		const facts = await hooks.pricingFacts(askC5)
		expect(facts?.facts).toMatchObject({
			legend: { gap: 'IdentityUnverified' },
			alumni: { gap: 'IdentityUnverified' },
			credit: { gap: 'IdentityUnverified' },
			creditUse: { gap: 'IdentityUnverified' },
			existingSeats: { gap: 'IdentityUnverified' },
		})
		expect(mocks.purchases).not.toHaveBeenCalled()
	})
	it('fails pricing facts when the merchant price is not exactly one active price', async () => {
		mocks.prices.mockResolvedValue([])
		await expect(
			hooks.pricingFacts({
				email: 'buyer@example.test',
				productId: 'product-s00zs',
				quantity: 1,
				orderKind: 'team',
			}),
		).rejects.toThrow()
		expect(mocks.purchases).not.toHaveBeenCalled()
	})
	it('returns null pricing facts for a product it does not support', async () => {
		expect(
			await hooks.pricingFacts({
				email: 'buyer@example.test',
				productId: 'product-ma254',
				quantity: 1,
				orderKind: 'individual',
			}),
		).toBeNull()
		expect(mocks.prices).not.toHaveBeenCalled()
	})
	it('returns null only for a missing Stripe resource, and propagates other failures to the facade', async () => {
		mocks.charge
			.mockRejectedValueOnce({ code: 'resource_missing' })
			.mockRejectedValueOnce(new Error('synthetic-error'))
		expect(await hooks.chargeState('ch_missing')).toBeNull()
		await expect(hooks.chargeState('ch_test')).rejects.toThrow(
			'synthetic-error',
		)
	})
})
