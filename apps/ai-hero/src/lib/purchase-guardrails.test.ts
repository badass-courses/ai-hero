import { describe, expect, it } from 'vitest'

import {
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
