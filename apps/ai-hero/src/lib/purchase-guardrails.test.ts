import { describe, expect, it } from 'vitest'

import {
	duplicatePurchaseGuard,
	hasActiveNonBulkPurchaseForProduct,
	requiresDuplicateActivePurchaseGuardrail,
} from './purchase-guardrails'

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

const EXISTING = {
	none: [],
	valid: [{ status: 'Valid', bulk: false }],
	restricted: [{ status: 'Restricted', bulk: false }],
	refunded: [{ status: 'Refunded', bulk: false }],
	bulkOnly: [{ status: 'Valid', bulk: true }],
}
const OWNS = new Set(['valid', 'restricted'])

describe('duplicatePurchaseGuard model', () => {
	for (const productType of ['cohort', 'cohort-archive', 'self-paced']) {
		for (const quantity of [1, 2, 5]) {
			for (const [name, existing] of Object.entries(EXISTING)) {
				for (const regional of [false, true]) {
					const guarded = requiresDuplicateActivePurchaseGuardrail(productType)
					const expected =
						quantity >= 2
							? regional
								? 'regional-team-not-allowed'
								: 'allow'
							: guarded && OWNS.has(name)
								? 'already-own'
								: 'allow'
					it(`${productType} q${quantity} ${name} regional=${regional} -> ${expected}`, () => {
						expect(
							duplicatePurchaseGuard({
								productType,
								quantity,
								existing,
								regionalCouponApplied: regional,
							}),
						).toBe(expected)
					})
				}
			}
		}
	}

	it('legacy predicate wrongly blocks a seat holder buying team seats', () => {
		expect(legacyBlocks('cohort', EXISTING.valid)).toBe(true)
		expect(
			duplicatePurchaseGuard({
				productType: 'cohort',
				quantity: 5,
				existing: EXISTING.valid,
				regionalCouponApplied: false,
			}),
		).toBe('allow')
	})
})
