import { describe, expect, it } from 'vitest'

import { resolvePurchaseGA4ClientId } from './ga4-purchase-fields'

describe('resolvePurchaseGA4ClientId', () => {
	it('uses the nested attribution GA client ID first', () => {
		expect(
			resolvePurchaseGA4ClientId({
				attribution: { ga: { clientId: 'nested.123' } },
				gaClientId: 'legacy.456',
			}),
		).toBe('nested.123')
	})

	it('falls back to the legacy purchase field', () => {
		expect(resolvePurchaseGA4ClientId({ gaClientId: 'legacy.456' })).toBe(
			'legacy.456',
		)
	})

	it('keeps missing GA client ID behavior unchanged', () => {
		expect(resolvePurchaseGA4ClientId({ attribution: { ga: {} } })).toBe(
			undefined,
		)
	})
})
