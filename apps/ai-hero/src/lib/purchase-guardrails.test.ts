import { describe, expect, it } from 'vitest'

import {
	duplicatePurchaseGuard,
	hasActiveNonBulkPurchaseForProduct,
	isRegionalCoupon,
	parseCheckoutQuantity,
	requiresDuplicateActivePurchaseGuardrail,
} from './purchase-guardrails'

import { AUTHORITATIVE_PPP_OFFER_ID } from '@coursebuilder/commerce/authoritative-price'

describe('purchase guardrails', () => {
	it('requires duplicate purchase guardrails for cohort archive products', () => {
		expect(requiresDuplicateActivePurchaseGuardrail('cohort-archive')).toBe(
			true,
		)
		expect(requiresDuplicateActivePurchaseGuardrail('self-paced')).toBe(false)
	})

	it('finds an active owned purchase for the same product', () => {
		const purchases = [
			{
				productId: 'product-1',
				status: 'Valid',
				bulkCouponId: null,
			},
		]

		expect(
			hasActiveNonBulkPurchaseForProduct(purchases as any, 'product-1'),
		).toBe(true)
	})

	it('ignores refunded and bulk purchases for duplicate purchase checks', () => {
		const purchases = [
			{
				productId: 'product-1',
				status: 'Refunded',
				bulkCouponId: null,
			},
			{
				productId: 'product-1',
				status: 'Valid',
				bulkCouponId: 'bulk-1',
			},
		]

		expect(
			hasActiveNonBulkPurchaseForProduct(purchases as any, 'product-1'),
		).toBe(false)
	})
})

/** The legacy check: quantity-blind, copied from the old verify-login. */
const legacyBlocks = (
	productType: string,
	existing: Array<{ status: string; bulk: boolean }>,
) =>
	requiresDuplicateActivePurchaseGuardrail(productType) &&
	existing.some((p) => ['Valid', 'Restricted'].includes(p.status) && !p.bulk)

const VALID = [{ status: 'Valid', bulk: false }]
const RESTRICTED = [{ status: 'Restricted', bulk: false }]
const REFUNDED = [{ status: 'Refunded', bulk: false }]
const BULK_ONLY = [{ status: 'Valid', bulk: true }]

type Row = [
	string, // case
	string, // productType
	number, // quantity
	Array<{ status: string; bulk: boolean }>, // existing
	boolean, // regional coupon applied
	string, // expected
]

// Literal rows from Joel's ruling: quantity >= 2 passes the duplicate guard,
// a regional coupon never rides on a team order, a single-seat duplicate stays
// blocked. Nothing here is derived from the implementation.
const ROWS: Row[] = [
	['single seat, no purchases', 'cohort', 1, [], false, 'allow'],
	['single seat, Valid holder', 'cohort', 1, VALID, false, 'already-own'],
	[
		'single seat, Restricted holder',
		'cohort',
		1,
		RESTRICTED,
		false,
		'already-own',
	],
	['single seat, refunded', 'cohort', 1, REFUNDED, false, 'allow'],
	['single seat, bulk-only', 'cohort', 1, BULK_ONLY, false, 'allow'],
	[
		'single seat, archive Valid holder',
		'cohort-archive',
		1,
		VALID,
		false,
		'already-own',
	],
	[
		'single seat, unguarded type Valid holder',
		'self-paced',
		1,
		VALID,
		false,
		'allow',
	],
	['single seat, no purchases, regional', 'cohort', 1, [], true, 'allow'],
	[
		'single seat, Restricted holder, regional',
		'cohort',
		1,
		RESTRICTED,
		true,
		'already-own',
	],
	['team of 2, no purchases', 'cohort', 2, [], false, 'allow'],
	['team of 2, Valid holder', 'cohort', 2, VALID, false, 'allow'],
	['team of 2, Restricted holder', 'cohort', 2, RESTRICTED, false, 'allow'],
	['team of 2, refunded', 'cohort', 2, REFUNDED, false, 'allow'],
	['team of 2, bulk-only', 'cohort', 2, BULK_ONLY, false, 'allow'],
	['team of 5, Valid holder', 'cohort', 5, VALID, false, 'allow'],
	['team of 5, Restricted holder', 'cohort', 5, RESTRICTED, false, 'allow'],
	[
		'team of 2, regional coupon',
		'cohort',
		2,
		[],
		true,
		'regional-team-not-allowed',
	],
	[
		'team of 2, Valid holder, regional coupon',
		'cohort',
		2,
		VALID,
		true,
		'regional-team-not-allowed',
	],
	[
		'team of 2, Restricted holder, regional coupon',
		'cohort',
		2,
		RESTRICTED,
		true,
		'regional-team-not-allowed',
	],
	[
		'team of 5, Restricted holder, regional coupon',
		'cohort',
		5,
		RESTRICTED,
		true,
		'regional-team-not-allowed',
	],
	[
		'team of 5, bulk-only, regional coupon',
		'cohort',
		5,
		BULK_ONLY,
		true,
		'regional-team-not-allowed',
	],
	[
		'team of 5, unguarded type, regional coupon',
		'self-paced',
		5,
		[],
		true,
		'regional-team-not-allowed',
	],
	[
		'team of 5, unguarded type, Valid holder',
		'self-paced',
		5,
		VALID,
		false,
		'allow',
	],
]

describe('duplicatePurchaseGuard truth table', () => {
	it.each(ROWS)(
		'%s',
		(_name, productType, quantity, existing, regional, expected) => {
			expect(
				duplicatePurchaseGuard({
					productType,
					quantity,
					existing,
					regionalCouponApplied: regional,
				}),
			).toBe(expected)
		},
	)

	it('legacy predicate wrongly blocks a seat holder buying team seats', () => {
		expect(legacyBlocks('cohort', VALID)).toBe(true)
		expect(
			duplicatePurchaseGuard({
				productType: 'cohort',
				quantity: 5,
				existing: VALID,
				regionalCouponApplied: false,
			}),
		).toBe('allow')
	})
})

describe('parseCheckoutQuantity', () => {
	it.each([
		[undefined, 1],
		[null, 1],
		['', 1],
		['1', 1],
		['2', 2],
		['30', 30],
	])('accepts %s', (raw, expected) => {
		expect(parseCheckoutQuantity(raw)).toBe(expected)
	})
	it.each([
		'0',
		'-1',
		'2.5',
		'1e1',
		'NaN',
		' 2',
		'2 ',
		'02',
		'1,2',
		'99999999999999999999',
	])('refuses %s', (raw) => {
		expect(parseCheckoutQuantity(raw)).toBeNull()
	})
})

describe('isRegionalCoupon', () => {
	it('is regional for the authoritative offer, a ppp coupon, or a requested PPP', () => {
		expect(isRegionalCoupon({ couponId: AUTHORITATIVE_PPP_OFFER_ID })).toBe(
			true,
		)
		expect(isRegionalCoupon({ couponId: 'c', couponType: 'ppp' })).toBe(true)
		expect(isRegionalCoupon({ requestedPPP: true })).toBe(true)
	})
	it('is not regional for no coupon, a bulk coupon, or a plain coupon', () => {
		expect(isRegionalCoupon({})).toBe(false)
		expect(isRegionalCoupon({ couponId: 'c', couponType: 'bulk' })).toBe(false)
		expect(isRegionalCoupon({ couponId: 'c', requestedPPP: false })).toBe(false)
	})
})
